import { z } from "zod";

import { HelperError } from "./helper-client.mjs";
import { formatTree } from "./tree.mjs";

const WAIT_CAP_MS = 10_000;

const PIXELS = "Screenshot pixels: divide by the last screenshot scale internally; "
  + "prefer elementId when one is available.";

const appField = z.string()
  .describe("Target app: bundle id (com.apple.Notes), app name (Notes), or numeric pid.");

const targetFields = {
  elementId: z.number().int().optional()
    .describe("Element id from the last get_app_state observation. Preferred over x,y."),
  x: z.number().optional().describe(`Horizontal coordinate. ${PIXELS}`),
  y: z.number().optional().describe(`Vertical coordinate. ${PIXELS}`),
};

const observeField = {
  observe: z.boolean().optional()
    .describe("Return post-action app state (diff + screenshot). Set false for batched sequences."),
  screenshot: z.boolean().optional()
    .describe("Include a screenshot in the post-action observation (default true)."),
};

function textResult(text, extra = {}) {
  return { content: [{ type: "text", text }], ...extra };
}

function describeError(error, app) {
  const name = app ? `"${app}"` : "the app";
  switch (error.code) {
    case "app_not_allowed":
      return `The user declined to let Devin use ${name}. Ask them to allow it in the Devin Computer Use menu-bar app.`;
    case "blocked_app":
      return `Devin cannot control ${name}: terminal applications are always blocked.`;
    case "app_not_found":
      return `Could not find a running app matching ${name}. Use list_apps or open_app first.`;
    case "stale_element":
      return "That element is gone. Call get_app_state again for fresh element ids.";
    case "no_window":
      return `${name} has no windows. Open a window first.`;
    case "permission_required":
      return `${error.message} Ask the user to grant it, then retry.`;
    case "timeout":
    case "helper_unavailable":
      return error.message;
    default:
      return `Helper error ${error.code}: ${error.message}`;
  }
}

export function createTools(client, {
  settleMs = 300,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  void now;
  const previousTrees = new Map(); // app string -> last get_app_state result
  const lastScale = new Map(); // app string -> screenshot px per window point

  const scaleFor = (app) => lastScale.get(app) ?? 1;

  function toWindowPoint(params) {
    const scale = scaleFor(params.app);
    const out = { ...params };
    if (typeof out.x === "number") {
      out.x = out.x / scale;
    }
    if (typeof out.y === "number") {
      out.y = out.y / scale;
    }
    for (const key of ["from", "to"]) {
      if (out[key] && typeof out[key].x === "number") {
        out[key] = { x: out[key].x / scale, y: out[key].y / scale };
      }
    }
    delete out.observe;
    delete out.screenshot;
    return out;
  }

  function rememberState(app, state) {
    if (state?.screenshot?.scale) {
      lastScale.set(app, state.screenshot.scale);
    }
    previousTrees.set(app, state);
    return state;
  }

  function stateContent(app, state, { fullTree = false } = {}) {
    const previous = previousTrees.get(app);
    const diffAgainst = fullTree || !previous ? null : previous;
    rememberState(app, state);
    const content = [{ type: "text", text: formatTree(state, { diffAgainst }) }];
    if (state?.screenshot?.png) {
      content.push({ type: "image", data: state.screenshot.png, mimeType: "image/png" });
    }
    return { content };
  }

  async function observe(app, { screenshot = true, fullTree = false } = {}) {
    try {
      const state = await client.request("get_app_state", { app, screenshot });
      return stateContent(app, state, { fullTree });
    } catch (error) {
      if (error instanceof HelperError) {
        return textResult(describeError(error, app), { isError: true });
      }
      throw error;
    }
  }

  async function act(method, params) {
    const { observe: doObserve = true, screenshot = true } = params;
    try {
      await client.request(method, toWindowPoint(params));
    } catch (error) {
      if (error instanceof HelperError) {
        return textResult(describeError(error, params.app), { isError: true });
      }
      throw error;
    }
    if (doObserve === false) {
      return textResult("ok");
    }
    await sleep(settleMs);
    return observe(params.app, { screenshot });
  }

  async function getAppState({ app, fullTree = false, screenshot = true }) {
    try {
      const state = await client.request("get_app_state", { app, screenshot });
      return stateContent(app, state, { fullTree });
    } catch (error) {
      if (error instanceof HelperError) {
        return textResult(describeError(error, app), { isError: true });
      }
      throw error;
    }
  }

  return [
    {
      name: "list_apps",
      description: "List running macOS apps that have windows, with bundle id, pid and window titles.",
      inputSchema: {},
      handler: async () => {
        try {
          const { apps } = await client.request("list_apps");
          const lines = (apps || []).map((app) => {
            const windows = (app.windows || [])
              .map((w) => `    [${w.id}] "${w.title ?? ""}" ${w.bounds?.join("x") ?? ""}`.trimEnd())
              .join("\n");
            return `${app.name} — ${app.bundleId} (pid ${app.pid})${app.active ? " [active]" : ""}`
              + (windows ? `\n${windows}` : "");
          });
          return textResult(lines.length ? lines.join("\n") : "No apps with windows found.");
        } catch (error) {
          if (error instanceof HelperError) {
            return textResult(describeError(error), { isError: true });
          }
          throw error;
        }
      },
    },
    {
      name: "get_app_state",
      description: "Observe an app: compact accessibility tree (diffed against the previous call) plus a window screenshot. "
        + "Call this before acting; use elementIds from the result.",
      inputSchema: {
        app: appField,
        fullTree: z.boolean().optional().describe("Return the full tree instead of a diff vs the previous observation."),
        screenshot: z.boolean().optional().describe("Include a window screenshot (default true)."),
      },
      handler: getAppState,
    },
    {
      name: "click",
      description: "Click an element (preferred) or a point in an app's window.",
      inputSchema: {
        app: appField,
        ...targetFields,
        button: z.enum(["left", "right"]).optional().describe("Mouse button (default left)."),
        count: z.union([z.literal(1), z.literal(2)]).optional().describe("1 = single click, 2 = double click."),
        ...observeField,
      },
      handler: (params) => act("click", params),
    },
    {
      name: "type_text",
      description: "Type text into an app, optionally focused on an element first.",
      inputSchema: {
        app: appField,
        text: z.string().describe("Text to type."),
        elementId: z.number().int().optional(),
        replace: z.boolean().optional().describe("Replace the element's current value first."),
        submit: z.boolean().optional().describe("Press Return after typing."),
        ...observeField,
      },
      handler: (params) => act("type_text", params),
    },
    {
      name: "press_key",
      description: "Press a named key (return, tab, escape, space, delete, arrows, f1-f12, a-z, 0-9) with optional modifiers.",
      inputSchema: {
        app: appField,
        key: z.string().describe("Key name, e.g. return, tab, escape, up, f5, a, 3."),
        modifiers: z.array(z.enum(["cmd", "shift", "alt", "ctrl"])).optional(),
        ...observeField,
      },
      handler: (params) => act("press_key", params),
    },
    {
      name: "scroll",
      description: "Scroll at an element or point in an app's window.",
      inputSchema: {
        app: appField,
        ...targetFields,
        dx: z.number().describe("Horizontal scroll amount in pixels."),
        dy: z.number().describe("Vertical scroll amount in pixels (positive scrolls content up)."),
        ...observeField,
      },
      handler: (params) => act("scroll", params),
    },
    {
      name: "drag",
      description: "Drag from one point to another in an app's window.",
      inputSchema: {
        app: appField,
        from: z.object({ x: z.number(), y: z.number() }).describe(`Start point. ${PIXELS}`),
        to: z.object({ x: z.number(), y: z.number() }).describe(`End point. ${PIXELS}`),
        ...observeField,
      },
      handler: (params) => act("drag", params),
    },
    {
      name: "open_app",
      description: "Launch or activate an app by name or bundle id, then return its state.",
      inputSchema: {
        app: appField,
        screenshot: z.boolean().optional(),
      },
      handler: async ({ app, screenshot = true }) => {
        try {
          await client.request("open_app", { app });
        } catch (error) {
          if (error instanceof HelperError) {
            return textResult(describeError(error, app), { isError: true });
          }
          throw error;
        }
        await sleep(settleMs);
        return observe(app, { screenshot, fullTree: true });
      },
    },
    {
      name: "wait",
      description: "Wait for the UI to settle before the next observation (max 10 s).",
      inputSchema: {
        ms: z.number().int().min(0).describe("Milliseconds to wait; capped at 10000."),
      },
      handler: async ({ ms }) => {
        const capped = Math.min(Math.max(ms ?? 0, 0), WAIT_CAP_MS);
        await sleep(capped);
        return textResult(`waited ${capped} ms`);
      },
    },
  ];
}
