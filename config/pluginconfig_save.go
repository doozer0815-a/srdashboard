package config

import (
	"fmt"
	"reflect"

	"github.com/beevik/etree"
)

// DiffOverrides returns keys in merged that differ from defaults (site overrides only).
func DiffOverrides(defaults, merged map[string]any) map[string]any {
	out := make(map[string]any)
	for k, v := range merged {
		dv, ok := defaults[k]
		// Persist boolean values explicitly, including false. This avoids a
		// disabled checkbox disappearing from config.xml and being restored
		// as enabled when the editor is reopened.
		if _, isBool := v.(bool); isBool {
			out[k] = v
			continue
		}
		if !ok || !valuesEqual(dv, v) {
			out[k] = v
		}
	}
	return out
}

func valuesEqual(a, b any) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	av := normalizeValue(a)
	bv := normalizeValue(b)
	return reflect.DeepEqual(av, bv)
}

func normalizeValue(v any) any {
	switch x := v.(type) {
	case float64:
		if x == float64(int64(x)) {
			return int(int64(x))
		}
		return x
	case int64:
		return int(x)
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, val := range x {
			out[k] = normalizeValue(val)
		}
		return out
	default:
		return v
	}
}

// SavePluginConfig writes site overrides to {configDir}/{pluginID}/config.xml,
// preserving existing XML comments where possible.
func SavePluginConfig(configDir, pluginID string, overrides map[string]any) error {
	if pluginID == "" {
		return fmt.Errorf("plugin id required")
	}
	path := PluginConfigPath(configDir, pluginID)
	doc, existed, err := loadXMLDoc(path)
	if err != nil {
		return err
	}

	root := doc.SelectElement("pluginConfig")
	if root == nil {
		root = doc.SelectElement("config")
	}
	if root == nil {
		root = ensureRoot(doc, "pluginConfig")
		root.Tag = "pluginConfig"
	}
	if attr := root.SelectAttr("id"); attr != nil {
		attr.Value = pluginID
	} else {
		root.CreateAttr("id", pluginID)
	}

	overrideKeys := make(map[string]bool, len(overrides))
	for k, v := range overrides {
		overrideKeys[k] = true
		upsertPluginConfigKey(root, k, v)
	}

	for _, name := range childElementNames(root) {
		if !overrideKeys[name] {
			if el := root.SelectElement(name); el != nil {
				root.RemoveChild(el)
			}
		}
	}

	if len(overrides) == 0 && !existed {
		return nil
	}
	return writeXMLDocAtomic(path, doc)
}

func upsertPluginConfigKey(root *etree.Element, key string, v any) {
	if key == "rangeDifficulties" || key == "rangeHandicaps" {
		upsertRangeScalarMap(root, key, v)
		return
	}
	if key == "rangeTargets" {
		upsertRangeNestedMap(root, key, v)
		return
	}
	if m, ok := v.(map[string]any); ok {
		el := selectOrCreate(root, key)
		for _, childName := range childElementNames(el) {
			if child := el.SelectElement(childName); child != nil {
				el.RemoveChild(child)
			}
		}
		for ck, cv := range m {
			child := el.CreateElement(ck)
			setScalarText(child, cv)
		}
		return
	}
	el := selectOrCreate(root, key)
	setScalarText(el, v)
}

func upsertRangeScalarMap(root *etree.Element, key string, v any) {
	m, ok := v.(map[string]any)
	if !ok {
		return
	}
	el := selectOrCreate(root, key)
	for _, child := range el.SelectElements("range") {
		el.RemoveChild(child)
	}
	for num, val := range m {
		r := el.CreateElement("range")
		r.CreateAttr("num", num)
		setScalarText(r, val)
	}
}

func upsertRangeNestedMap(root *etree.Element, key string, v any) {
	m, ok := v.(map[string]any)
	if !ok {
		return
	}
	el := selectOrCreate(root, key)
	for _, child := range el.SelectElements("range") {
		el.RemoveChild(child)
	}
	for num, val := range m {
		r := el.CreateElement("range")
		r.CreateAttr("num", num)
		sub, ok := val.(map[string]any)
		if !ok {
			setScalarText(r, val)
			continue
		}
		for sk, sv := range sub {
			child := r.CreateElement(sk)
			setScalarText(child, sv)
		}
	}
}
