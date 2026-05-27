package api

import (
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/xuri/excelize/v2"
)

// GET /api/canvas/sheets/{id}/export?code=CANVAS_CODE
//
// Public endpoint (no JWT). The `code` query param identifies the canvas; the
// {id} path param identifies the sheet. We verify the sheet belongs to that
// canvas before exporting. This mirrors the WS security model (code = read
// access to a canvas).
//
// Returns an .xlsx file with the sheet rendered as a single worksheet. Cell
// values are typed per column: text/date as strings (date parsed to time), number
// as floats with right-aligned numeric format, checkbox as TRUE/FALSE booleans.
func (h *Handler) ExportSheet(w http.ResponseWriter, r *http.Request) {
	code := strings.ToUpper(r.URL.Query().Get("code"))
	if code == "" {
		writeError(w, http.StatusBadRequest, "code query parameter required")
		return
	}
	sheetID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid sheet id")
		return
	}

	canvas, err := h.store.GetCanvasByCode(r.Context(), code)
	if err != nil {
		writeError(w, http.StatusNotFound, "canvas not found")
		return
	}
	_, state, _, err := h.store.GetCanvasState(r.Context(), canvas.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not load canvas state")
		return
	}
	sheet, ok := state.Sheets[sheetID.String()]
	if !ok {
		writeError(w, http.StatusNotFound, "sheet not found in canvas")
		return
	}

	rows := make([]*store.SheetRow, 0)
	for _, row := range state.SheetRows {
		if row.SheetID == sheetID {
			rows = append(rows, row)
		}
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].SortOrder != rows[j].SortOrder {
			return rows[i].SortOrder < rows[j].SortOrder
		}
		return rows[i].UpdatedAt.Before(rows[j].UpdatedAt)
	})

	columns := append([]store.SheetColumn(nil), sheet.Columns...)
	sort.Slice(columns, func(i, j int) bool { return columns[i].SortOrder < columns[j].SortOrder })

	xlsxBytes, err := buildXLSX(sheet.Name, columns, rows)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not build xlsx: "+err.Error())
		return
	}

	filename := sanitizeFilename(sheet.Name)
	if filename == "" {
		filename = "sheet"
	}
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.xlsx"`, filename))
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(xlsxBytes)))
	_, _ = w.Write(xlsxBytes)
}

// buildXLSX renders one worksheet from the given columns + rows. Cell types
// match the column type so Excel/Numbers display numbers right-aligned, dates
// as dates, and checkboxes as TRUE/FALSE.
func buildXLSX(sheetName string, columns []store.SheetColumn, rows []*store.SheetRow) ([]byte, error) {
	f := excelize.NewFile()
	defer f.Close()

	wsName := sanitizeSheetName(sheetName)
	if wsName == "" {
		wsName = "Sheet1"
	}
	// excelize starts with a default "Sheet1"; rename it if our name differs,
	// otherwise reuse it.
	if wsName != "Sheet1" {
		if err := f.SetSheetName("Sheet1", wsName); err != nil {
			return nil, err
		}
	}

	// Header row (bold).
	headerStyle, _ := f.NewStyle(&excelize.Style{
		Font: &excelize.Font{Bold: true},
		Fill: excelize.Fill{Type: "pattern", Color: []string{"F3F4F6"}, Pattern: 1},
	})
	dateStyle, _ := f.NewStyle(&excelize.Style{NumFmt: 14}) // m/d/yyyy

	for i, col := range columns {
		cell, _ := excelize.CoordinatesToCellName(i+1, 1)
		_ = f.SetCellValue(wsName, cell, col.Name)
	}
	if len(columns) > 0 {
		last, _ := excelize.CoordinatesToCellName(len(columns), 1)
		_ = f.SetCellStyle(wsName, "A1", last, headerStyle)
	}

	// Data rows.
	for rIdx, row := range rows {
		for cIdx, col := range columns {
			cell, _ := excelize.CoordinatesToCellName(cIdx+1, rIdx+2)
			val, ok := row.Data[col.ID]
			if !ok || val == nil {
				continue
			}
			switch col.Type {
			case "number":
				switch v := val.(type) {
				case float64:
					_ = f.SetCellFloat(wsName, cell, v, -1, 64)
				case float32:
					_ = f.SetCellFloat(wsName, cell, float64(v), -1, 32)
				case int:
					_ = f.SetCellInt(wsName, cell, int64(v))
				case int64:
					_ = f.SetCellInt(wsName, cell, v)
				default:
					_ = f.SetCellValue(wsName, cell, fmt.Sprint(v))
				}
			case "checkbox":
				b, _ := val.(bool)
				_ = f.SetCellBool(wsName, cell, b)
			case "date":
				s, _ := val.(string)
				if t, err := time.Parse("2006-01-02", s); err == nil {
					_ = f.SetCellValue(wsName, cell, t)
					_ = f.SetCellStyle(wsName, cell, cell, dateStyle)
				} else if s != "" {
					_ = f.SetCellValue(wsName, cell, s)
				}
			default: // text + unknown
				_ = f.SetCellValue(wsName, cell, fmt.Sprint(val))
			}
		}
	}

	// Auto-widen columns to roughly fit content. Excelize doesn't auto-fit, so
	// estimate from longest cell value per column (capped to keep things sane).
	for i, col := range columns {
		w := estimateColumnWidth(col, rows)
		letter, _ := excelize.ColumnNumberToName(i + 1)
		_ = f.SetColWidth(wsName, letter, letter, w)
	}

	buf, err := f.WriteToBuffer()
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func estimateColumnWidth(col store.SheetColumn, rows []*store.SheetRow) float64 {
	maxLen := len(col.Name)
	for _, r := range rows {
		v := r.Data[col.ID]
		if v == nil {
			continue
		}
		s := fmt.Sprint(v)
		if len(s) > maxLen {
			maxLen = len(s)
		}
	}
	w := float64(maxLen) + 2
	if w < 10 {
		w = 10
	}
	if w > 50 {
		w = 50
	}
	return w
}

// sanitizeSheetName strips characters Excel disallows in worksheet tab names
// (\ / * ? : [ ]) and truncates to 31 chars (Excel's max).
var sheetNameForbidden = regexp.MustCompile(`[\\/*?:\[\]]`)

func sanitizeSheetName(name string) string {
	cleaned := sheetNameForbidden.ReplaceAllString(strings.TrimSpace(name), "_")
	if len(cleaned) > 31 {
		cleaned = cleaned[:31]
	}
	return cleaned
}

// sanitizeFilename strips characters that cause grief in Content-Disposition
// (quotes, slashes, control bytes). Also strips non-ASCII to dodge the
// filename*=UTF-8'' rabbit hole; callers can localize later if needed.
var filenameForbidden = regexp.MustCompile(`[^\w\- .]`)

func sanitizeFilename(name string) string {
	return strings.TrimSpace(filenameForbidden.ReplaceAllString(name, "_"))
}
