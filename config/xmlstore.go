package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/beevik/etree"
)

func loadXMLDoc(path string) (*etree.Document, bool, error) {
	doc := etree.NewDocument()
	doc.ReadSettings.PreserveCData = true
	if err := doc.ReadFromFile(path); err != nil {
		if os.IsNotExist(err) {
			doc.CreateProcInst("xml", `version="1.0" encoding="UTF-8"`)
			return doc, false, nil
		}
		return nil, false, err
	}
	return doc, true, nil
}

func writeXMLDocAtomic(path string, doc *etree.Document) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	doc.Indent(2)
	tmp, err := os.CreateTemp(dir, ".config-*.xml")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)

	if _, err := doc.WriteTo(tmp); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

func ensureRoot(doc *etree.Document, name string) *etree.Element {
	root := doc.Root()
	if root == nil {
		root = doc.CreateElement(name)
	}
	return root
}

func childElementNames(parent *etree.Element) []string {
	var names []string
	for _, ch := range parent.Child {
		if el, ok := ch.(*etree.Element); ok {
			names = append(names, el.Tag)
		}
	}
	return names
}

func selectOrCreate(parent *etree.Element, tag string) *etree.Element {
	if el := parent.SelectElement(tag); el != nil {
		return el
	}
	return parent.CreateElement(tag)
}

func setScalarText(el *etree.Element, v any) {
	el.SetText(formatScalar(v))
}

func formatScalar(v any) string {
	if v == nil {
		return ""
	}
	switch x := v.(type) {
	case bool:
		if x {
			return "true"
		}
		return "false"
	case int:
		return fmt.Sprintf("%d", x)
	case int64:
		return fmt.Sprintf("%d", x)
	case float64:
		if x == float64(int64(x)) {
			return fmt.Sprintf("%d", int64(x))
		}
		return fmt.Sprintf("%g", x)
	case string:
		return x
	default:
		return fmt.Sprintf("%v", v)
	}
}
