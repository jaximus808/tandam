package api

import (
	"io"
	"mime/multipart"
	"os"

	"github.com/google/uuid"
)

func newFileID() string {
	return uuid.New().String()
}

func writeFile(dest string, src multipart.File) error {
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, src)
	return err
}
