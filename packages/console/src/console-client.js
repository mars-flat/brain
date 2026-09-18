/**
 * The console's one shared script (§16.4), loaded on every authed page:
 * opens <dialog>s from [data-dialog] buttons (the tasks edit modal), lets a
 * toast be dismissed, and drops ?ok=/?err= from the address bar so a
 * refresh never replays a notice. Same-origin, module, no dependencies —
 * the CSP admits nothing else.
 */

for (const button of document.querySelectorAll("[data-dialog]")) {
  button.addEventListener("click", () => {
    const dialog = document.getElementById(button.dataset.dialog);
    if (dialog && typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
  });
}

for (const toast of document.querySelectorAll("[data-toast]")) {
  toast.querySelector(".x")?.addEventListener("click", () => toast.remove());
}

const url = new URL(location.href);
const noticeParams = ["ok", "err", "refreshed", "throttled"];
if (noticeParams.some((k) => url.searchParams.has(k))) {
  for (const k of noticeParams) url.searchParams.delete(k);
  history.replaceState(null, "", url.pathname + url.search + url.hash);
}
