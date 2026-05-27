package maps

import (
	"io/fs"
	"os"
)

// dirFS returns an fs.FS rooted at the given directory. Thin wrapper to keep
// the registry loader symmetric between embed.FS and os.DirFS.
func dirFS(root string) fs.FS {
	return os.DirFS(root)
}
