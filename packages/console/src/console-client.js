/**
 * The console's one shared script (§16.4), loaded on every authed page:
 * opens <dialog>s from [data-dialog] buttons (the tasks edit modal), lets a
 * toast be dismissed, drops ?ok=/?err= from the address bar so a refresh
 * never replays a notice, and makes the tasks board draggable. Same-origin,
 * module, no dependencies — the CSP admits nothing else.
 */

// The board: a todo card dropped on the done column goes where its own
// "done" button goes — the "schedule again?" page. The drop is a shortcut
// to that form, never a write of its own, so the no-script path and the
// drag path cannot disagree (brain-console-design §6).
let dragged = null;
for (const card of document.querySelectorAll("[data-drag]")) {
  card.addEventListener("dragstart", (e) => {
    dragged = card;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", card.dataset.drag);
  });
  card.addEventListener("dragend", () => {
    card.classList.remove("dragging");
    dragged = null;
  });
}
for (const zone of document.querySelectorAll("[data-drop]")) {
  zone.addEventListener("dragover", (e) => {
    if (!dragged) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    zone.classList.add("over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("over");
    const href = dragged?.dataset.drag;
    if (href?.startsWith("/tasks/")) location.assign(href);
  });
}

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
