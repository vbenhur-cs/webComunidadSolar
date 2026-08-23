import { parse, serialize, type DefaultTreeAdapterTypes } from "parse5";

const removedElements = new Set(["script", "object", "embed"]);

function isRefreshMeta(node: DefaultTreeAdapterTypes.Element): boolean {
  if (node.tagName !== "meta") {
    return false;
  }
  return node.attrs.some(
    (attribute) =>
      attribute.name.toLowerCase() === "http-equiv" &&
      attribute.value.toLowerCase() === "refresh",
  );
}

function sanitizeChildren(node: DefaultTreeAdapterTypes.ParentNode): void {
  node.childNodes = node.childNodes.filter((child) => {
    if (
      "tagName" in child &&
      (removedElements.has(child.tagName) || isRefreshMeta(child))
    ) {
      return false;
    }
    return true;
  });
  for (const child of node.childNodes) {
    if ("tagName" in child) {
      sanitizeElement(child);
    }
  }
}

function sanitizeElement(node: DefaultTreeAdapterTypes.Element): void {
  node.attrs = node.attrs.filter(
    (attribute) => !attribute.name.toLowerCase().startsWith("on"),
  );
  sanitizeChildren(node);
  if (node.tagName === "template") {
    sanitizeChildren((node as DefaultTreeAdapterTypes.Template).content);
  }
}

/**
 * Parses supplied HTML as inert data and returns its sanitized body fragment.
 * It deliberately never evaluates script, event-handler, plugin, or refresh data.
 */
export function extractSafeHtmlBody(source: string): string {
  const document = parse(source);
  const html = document.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element =>
      "tagName" in node && node.tagName === "html",
  );
  const body = html?.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element =>
      "tagName" in node && node.tagName === "body",
  );
  if (body === undefined) {
    throw new TypeError("El HTML aportado debe contener un body");
  }

  sanitizeElement(body);
  return serialize(body);
}
