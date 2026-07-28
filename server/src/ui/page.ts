/**
 * The shell's one element: on connect it loads the current path and mounts
 * whatever the renderer produced.
 */

import { loadView, serverOrigin } from "./load.js";

export const PAGE_TAG = "autofile-page";

export class AutofilePage extends HTMLElement {
  connectedCallback(): void {
    void this.load();
  }

  async load(): Promise<void> {
    const view = await loadView(serverOrigin(), location.pathname);
    this.replaceChildren(view);
  }
}

export function definePage(): void {
  if (!customElements.get(PAGE_TAG)) {
    customElements.define(PAGE_TAG, AutofilePage);
  }
}
