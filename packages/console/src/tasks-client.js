/**
 * The tasks tab's only script (§16.4): opens <dialog> elements from
 * [data-dialog] buttons — the edit modal. Everything else on the tab is
 * forms and CSS (the custom-interval and time inputs show/hide with :has()).
 * Same-origin, module, no dependencies; the CSP admits nothing else.
 */

for (const button of document.querySelectorAll("[data-dialog]")) {
  button.addEventListener("click", () => {
    const dialog = document.getElementById(button.dataset.dialog);
    if (dialog && typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
  });
}
