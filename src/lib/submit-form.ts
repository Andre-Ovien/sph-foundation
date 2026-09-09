export async function submitForm(form: HTMLFormElement, status: HTMLElement | null, kind: string) {
  if (form.dataset.sending === "true") return;
  const data = new FormData(form);
  if ([...data.values()].some(value => value instanceof File && value.size > 0)) {
    status?.replaceChildren("Document delivery is not enabled yet. Remove the selected files to send your inquiry without attachments.");
    return;
  }
  const fields = Object.fromEntries([...data.entries()].filter((entry) => typeof entry[1] === "string"));
  const payload = JSON.stringify({ kind, fields });
  if (form.dataset.lastPayload !== payload) {
    // randomUUID requires HTTPS; getRandomValues also works on a phone's LAN preview.
    form.dataset.requestId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, char => (Number(char) ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> Number(char) / 4).toString(16));
    form.dataset.lastPayload = payload;
  }
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  form.dataset.sending = "true";
  if (button) button.disabled = true;
  status?.replaceChildren("Sending…");
  try {
    const response = await fetch("/api/forms", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": form.dataset.requestId! },
      body: payload,
    });
    if (response.status === 429) throw new Error("Please wait a minute before trying again.");
    const result = await response.json().catch(() => ({ message: "Delivery is temporarily unavailable. Please try again." }));
    if (!response.ok) throw new Error(result.message || "We couldn’t send your message. Please try again.");
    status?.replaceChildren(result.message);
  } catch (error) {
    status?.replaceChildren(error instanceof Error ? error.message : "Connection interrupted. Please try again.");
  } finally {
    form.dataset.sending = "false";
    if (button) button.disabled = false;
  }
}
