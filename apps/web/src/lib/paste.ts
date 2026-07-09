/* Paste power (roadmap item 13). Two self-contained helpers, no deps:
   - parseClipboardGrid: TSV/Excel clipboard text → a 2D grid, for pasting a
     block into a sheet that auto-grows rows/columns.
   - htmlToMarkdown: rich clipboard HTML (webpage, Google Docs) → Markdown, so a
     paste into a note keeps its formatting instead of flattening to plain text. */

/** Parse spreadsheet clipboard text (tab-separated, newline rows) into a grid.
    Excel / Google Sheets / Numbers all copy as TSV in text/plain. Returns [] for
    a single plain value (caller should fall back to the browser's default paste). */
export function parseClipboardGrid(text: string): string[][] {
  if (!text) return [];
  // Normalise line endings, then drop a single trailing newline (spreadsheets
  // append one) so we don't synthesise a phantom empty row.
  const normalised = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  if (!normalised.includes("\t") && !normalised.includes("\n")) return [];
  return normalised.split("\n").map((line) => line.split("\t"));
}

/** Convert an HTML fragment (as found on a clipboard) to Markdown. Handles the
    common tags — headings, bold/italic, links, lists, code, blockquotes, and
    GFM tables — and falls back to text content for anything unrecognised. Not a
    full HTML→MD engine; enough that pasting a webpage or Google-Docs selection
    lands as readable Markdown. */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const md = serializeChildren(doc.body).trim();
  // Collapse runs of 3+ blank lines that block-stacking can produce.
  return md.replace(/\n{3,}/g, "\n\n");
}

function serializeChildren(node: Node): string {
  let out = "";
  node.childNodes.forEach((child) => {
    out += serializeNode(child);
  });
  return out;
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    // Collapse whitespace like HTML rendering does; real breaks come from tags.
    return (node.textContent ?? "").replace(/\s+/g, " ");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const inner = () => serializeChildren(el);

  switch (tag) {
    case "h1": return `\n\n# ${inner().trim()}\n\n`;
    case "h2": return `\n\n## ${inner().trim()}\n\n`;
    case "h3": return `\n\n### ${inner().trim()}\n\n`;
    case "h4": return `\n\n#### ${inner().trim()}\n\n`;
    case "h5": return `\n\n##### ${inner().trim()}\n\n`;
    case "h6": return `\n\n###### ${inner().trim()}\n\n`;
    case "strong":
    case "b": {
      const t = inner().trim();
      return t ? `**${t}**` : "";
    }
    case "em":
    case "i": {
      const t = inner().trim();
      return t ? `*${t}*` : "";
    }
    case "code":
      // Inline code unless it sits inside a <pre> (handled below).
      return el.closest("pre") && el.parentElement?.tagName.toLowerCase() === "pre"
        ? inner()
        : `\`${el.textContent ?? ""}\``;
    case "pre":
      return `\n\n\`\`\`\n${(el.textContent ?? "").replace(/\n$/, "")}\n\`\`\`\n\n`;
    case "a": {
      const href = el.getAttribute("href");
      const t = inner().trim();
      return href ? `[${t || href}](${href})` : t;
    }
    case "br":
      return "  \n";
    case "p":
    case "div":
      return `\n\n${inner().trim()}\n\n`;
    case "blockquote":
      return `\n\n${inner().trim().split("\n").map((l) => `> ${l}`).join("\n")}\n\n`;
    case "ul":
    case "ol":
      return `\n${serializeList(el, tag === "ol")}\n`;
    case "table":
      return `\n\n${serializeTable(el)}\n\n`;
    case "hr":
      return `\n\n---\n\n`;
    case "script":
    case "style":
      return "";
    default:
      return inner();
  }
}

function serializeList(list: Element, ordered: boolean, depth = 0): string {
  const indent = "  ".repeat(depth);
  const items = Array.from(list.children).filter(
    (c) => c.tagName.toLowerCase() === "li",
  );
  return items
    .map((li, i) => {
      const marker = ordered ? `${i + 1}.` : "-";
      // Pull nested lists out so they render on their own indented lines.
      const nested = Array.from(li.children).filter((c) =>
        ["ul", "ol"].includes(c.tagName.toLowerCase()),
      );
      const own = serializeChildrenExcluding(li, nested).trim().replace(/\n+/g, " ");
      let line = `${indent}${marker} ${own}`;
      for (const sub of nested) {
        line += `\n${serializeList(sub, sub.tagName.toLowerCase() === "ol", depth + 1)}`;
      }
      return line;
    })
    .join("\n");
}

function serializeChildrenExcluding(node: Element, exclude: Element[]): string {
  let out = "";
  node.childNodes.forEach((child) => {
    if (exclude.includes(child as Element)) return;
    out += serializeNode(child);
  });
  return out;
}

function serializeTable(table: HTMLElement): string {
  const rows = Array.from(table.querySelectorAll("tr"));
  if (rows.length === 0) return "";
  const cellText = (cell: Element) =>
    serializeChildren(cell).trim().replace(/\n+/g, " ").replace(/\|/g, "\\|");

  const grid = rows.map((tr) =>
    Array.from(tr.querySelectorAll("th,td")).map(cellText),
  );
  const width = Math.max(...grid.map((r) => r.length));
  const pad = (r: string[]) => {
    const c = [...r];
    while (c.length < width) c.push("");
    return c;
  };

  const header = pad(grid[0]);
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...grid.slice(1).map((r) => `| ${pad(r).join(" | ")} |`),
  ];
  return lines.join("\n");
}
