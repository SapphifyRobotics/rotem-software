// Styled replacement for every native <select>, so no browser-drawn menu ever appears.
// The native element stays in the DOM (hidden) as the source of truth: forms, `.value`
// and `change` events keep working, and setting `.value` from code updates the display.

const valueDesc = Object.getOwnPropertyDescriptor(
  HTMLSelectElement.prototype,
  "value",
)!;
const disabledDesc = Object.getOwnPropertyDescriptor(
  HTMLSelectElement.prototype,
  "disabled",
)!;
let openMenu: (() => void) | null = null;

export function enhanceSelects(root: ParentNode = document) {
  root
    .querySelectorAll<HTMLSelectElement>("select:not([data-enhanced])")
    .forEach(enhance);
}

function accessibleName(sel: HTMLSelectElement) {
  const label = sel.labels?.[0]?.cloneNode(true) as HTMLElement | undefined;
  label?.querySelectorAll("select, button").forEach(node => node.remove());
  return sel.getAttribute("aria-label") || label?.textContent?.trim() || sel.id || "Choose option";
}

function segmented(sel: HTMLSelectElement) {
  const wrap = document.createElement("div");
  wrap.className = "choice-options";
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", accessibleName(sel));
  sel.after(wrap);
  sel.hidden = true;
  sel.tabIndex = -1;
  const buttons = Array.from(sel.options, option => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option.textContent;
    button.onclick = () => {
      sel.value = option.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    };
    wrap.append(button);
    return button;
  });
  const sync = () => buttons.forEach((button, index) => {
    button.setAttribute("aria-pressed", String(sel.selectedIndex === index));
    button.disabled = sel.disabled || sel.options[index].disabled;
  });
  Object.defineProperty(sel, "value", {
    get() { return valueDesc.get!.call(sel); },
    set(value) { valueDesc.set!.call(sel, value); sync(); },
  });
  Object.defineProperty(sel, "disabled", {
    get() { return disabledDesc.get!.call(sel); },
    set(value) { disabledDesc.set!.call(sel, value); sync(); },
  });
  sel.addEventListener("change", sync);
  sync();
}

function enhance(sel: HTMLSelectElement) {
  sel.dataset.enhanced = "1";
  if (sel.options.length <= 4) { segmented(sel); return; }
  const wrap = document.createElement("div");
  wrap.className = "sel";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sel-btn";
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("role", "combobox");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-label", accessibleName(sel));
  const menuId = "options-" + (sel.id || Math.random().toString(36).slice(2));
  btn.setAttribute("aria-controls", menuId);
  const label = document.createElement("span");
  const chev = document.createElement("i");
  chev.className = "sel-chev";
  chev.setAttribute("aria-hidden", "true");
  btn.append(label, chev);
  const list = document.createElement("ul");
  list.className = "sel-list";
  list.setAttribute("role", "listbox");
  list.id = menuId;
  list.hidden = true;
  sel.after(wrap);
  wrap.append(sel, btn, list);
  sel.hidden = true;
  sel.tabIndex = -1;

  let active = -1;
  const opts = () => Array.from(sel.options);
  const render = () => {
    label.textContent = sel.selectedOptions[0]?.textContent ?? "";
    list.innerHTML = "";
    opts().forEach((o, i) => {
      const li = document.createElement("li");
      li.id = menuId + "-" + i;
      li.setAttribute("role", "option");
      li.textContent = o.textContent;
      li.setAttribute("aria-selected", String(o.selected));
      if (i === active) li.classList.add("active");
      li.onpointerdown = (e) => {
        e.preventDefault();
        choose(i);
      };
      li.onpointerenter = () => {
        active = i;
        mark();
      };
      list.append(li);
    });
  };
  const mark = () => {
    btn.setAttribute("aria-activedescendant", menuId + "-" + active);
    list
      .querySelectorAll("li")
      .forEach((li, i) => li.classList.toggle("active", i === active));
  };
  const choose = (i: number) => {
    const changed = sel.selectedIndex !== i;
    sel.selectedIndex = i;
    close();
    render();
    if (changed) sel.dispatchEvent(new Event("change", { bubbles: true }));
    btn.focus();
  };
  const open = () => {
    if (sel.disabled) return;
    openMenu?.();
    active = sel.selectedIndex;
    render();
    mark();
    list.hidden = false;
    wrap.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
    // Open upward when there is no room below.
    const r = btn.getBoundingClientRect();
    wrap.classList.toggle(
      "up",
      window.innerHeight - r.bottom < Math.min(260, list.scrollHeight + 12) &&
        r.top > 260,
    );
    openMenu = close;
  };
  function close() {
    btn.removeAttribute("aria-activedescendant");
    list.hidden = true;
    wrap.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
    if (openMenu === close) openMenu = null;
  }

  btn.onclick = () => (list.hidden ? open() : close());
  btn.onkeydown = (e) => {
    const n = sel.options.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.hidden) {
        open();
        return;
      }
      active = (active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      mark();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (list.hidden) open();
      else if (active >= 0) choose(active);
    } else if (e.key === "Escape") close();
    else if (e.key === "Tab") close();
  };
  btn.onblur = () =>
    setTimeout(() => {
      if (!wrap.contains(document.activeElement)) close();
    }, 0);

  // Keep the display in step with code that sets .value, .selectedIndex or .disabled.
  Object.defineProperty(sel, "value", {
    get() {
      return valueDesc.get!.call(sel);
    },
    set(v) {
      valueDesc.set!.call(sel, v);
      render();
    },
  });
  Object.defineProperty(sel, "disabled", {
    get() {
      return disabledDesc.get!.call(sel);
    },
    set(v) {
      disabledDesc.set!.call(sel, v);
      btn.disabled = !!v;
    },
  });
  const syncClass = () =>
    wrap.classList.toggle("dirty", sel.classList.contains("dirty"));
  new MutationObserver(syncClass).observe(sel, {
    attributes: true,
    attributeFilter: ["class"],
  });
  btn.disabled = sel.disabled;
  render();
}

document.addEventListener("pointerdown", (e) => {
  if (openMenu && !(e.target as Element).closest(".sel")) openMenu();
});
