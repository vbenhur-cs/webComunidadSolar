export const openCookieSettingsEvent = "comunidad-solar:open-cookie-settings";

export function openCookieSettings(): void {
  window.dispatchEvent(new Event(openCookieSettingsEvent));
}

export function bindCookieSettings(root: ParentNode = document): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "[data-cookie-settings]",
  )) {
    button.addEventListener("click", openCookieSettings);
  }
}
