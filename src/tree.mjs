// Pure helpers for rendering the helper's flattened AX tree as compact text
// and for diffing consecutive observations. See docs/DESIGN.md.

function escapeText(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/"/g, "\\\"");
}

function header(state, mode) {
  const name = state.app?.name || state.app?.bundleId || "app";
  const title = state.window?.title ?? "";
  const count = state.elements?.length ?? 0;
  const flags = [mode];
  if (state.truncated) {
    flags.push("truncated");
  }
  return `window: ${name} — "${escapeText(title)}" (${count} elements, ${flags.join(", ")})`;
}

export function formatElement(el) {
  let line = `${"  ".repeat(el.depth ?? 0)}[${el.id}] ${el.role}`;
  if (el.label != null && el.label !== "") {
    line += ` "${escapeText(el.label)}"`;
  }
  if (el.value != null && el.value !== "") {
    line += ` value="${escapeText(el.value)}"`;
  }
  if (el.focused) {
    line += " focused";
  }
  if (el.enabled === false) {
    line += " disabled";
  }
  return line;
}

// Stable diff identity: (role, label, path-of-labelled-ancestors). The flat
// list plus depth is enough to reconstruct labelled ancestors — ids are
// re-issued each observation so they cannot be used as keys.
export function elementKey(el, elements) {
  const index = elements.indexOf(el);
  const ancestors = [];
  let depth = el.depth ?? 0;
  for (let i = (index === -1 ? elements.length : index) - 1; i >= 0 && depth > 0; i -= 1) {
    const candidate = elements[i];
    const candidateDepth = candidate.depth ?? 0;
    if (candidateDepth < depth) {
      if (candidate.label) {
        ancestors.unshift(`${candidate.role}:${candidate.label}`);
      }
      depth = candidateDepth;
    }
  }
  return `${el.role}|${el.label ?? ""}|${ancestors.join("/")}`;
}

function comparable(el) {
  return [
    el.label ?? "",
    el.value ?? "",
    el.focused ? "1" : "0",
    el.enabled === false ? "0" : "1",
    (el.bounds || []).join(","),
  ].join("|");
}

// Returns an array of diff lines: `+` added, `-` removed, `~` changed.
// Changed elements emit `-` for the old rendering followed by `~` for the new
// one (new id, since ids are re-issued each observation).
export function diffTrees(prev, next) {
  const prevElements = prev?.elements ?? [];
  const nextElements = next?.elements ?? [];

  const prevByKey = new Map();
  for (const el of prevElements) {
    const key = elementKey(el, prevElements);
    if (!prevByKey.has(key)) {
      prevByKey.set(key, []);
    }
    prevByKey.get(key).push(el);
  }

  const lines = [];
  const used = new Map();
  for (const el of nextElements) {
    const key = elementKey(el, nextElements);
    const candidates = prevByKey.get(key) || [];
    const offset = used.get(key) || 0;
    const previous = candidates[offset] || null;
    used.set(key, offset + 1);
    if (!previous) {
      lines.push(`+ ${formatElement(el)}`);
    } else if (comparable(previous) !== comparable(el)) {
      lines.push(`- ${formatElement(previous)}`);
      lines.push(`~ ${formatElement(el)}`);
    }
  }

  const consumed = new Set();
  for (const [key, count] of used) {
    const candidates = prevByKey.get(key) || [];
    for (let i = 0; i < Math.min(count, candidates.length); i += 1) {
      consumed.add(candidates[i]);
    }
  }
  for (const el of prevElements) {
    if (!consumed.has(el)) {
      lines.push(`- ${formatElement(el)}`);
      consumed.add(el);
    }
  }

  return lines;
}

// state: the helper's get_app_state result. diffAgainst: previous state object
// (or null) to diff against.
export function formatTree(state, { diffAgainst = null } = {}) {
  const lines = [];
  if (diffAgainst) {
    lines.push(header(state, "diff vs previous"));
    const diff = diffTrees(diffAgainst, state);
    if (diff.length === 0) {
      lines.push("(no changes)");
    } else {
      lines.push(...diff);
    }
  } else {
    lines.push(header(state, "full"));
    for (const el of state.elements ?? []) {
      lines.push(formatElement(el));
    }
  }
  return lines.join("\n");
}
