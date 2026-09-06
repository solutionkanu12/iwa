// Final responsive verification against a production preview through Chrome's
// DevTools Protocol. This is test tooling only: it drives React state setters
// in the loaded page so every wallet combination and the loaded Prize Savings
// action layout can be inspected without a real wallet or a transaction.
//
// Usage: node .scripts/ux-final-check.mjs <browserWsUrl> <baseUrl> [outDir]

const WS = process.argv[2];
const BASE = process.argv[3];
const OUT = process.argv[4] || `${process.env.TEMP}/iwa-final-ux`;
if (!WS || !BASE) {
  console.error("usage: node ux-final-check.mjs <browserWsUrl> <baseUrl> [outDir]");
  process.exit(1);
}

const fs = await import("node:fs");
const path = await import("node:path");
fs.mkdirSync(OUT, { recursive: true });

let counter = 0;
const handlers = new Map();
const failures = [];

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("websocket connection failed"));
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && handlers.has(message.id)) {
        handlers.get(message.id)(message);
        handlers.delete(message.id);
      }
    };
  });
}

function request(ws, method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++counter;
    handlers.set(id, (message) => {
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

async function evaluate(ws, sessionId, expression) {
  const result = await request(
    ws,
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(
      String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text),
    );
  }
  return result.result?.value;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(condition, label, detail = "") {
  const result = condition ? "PASS" : "FAIL";
  console.log(`${result} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
}

async function openPage(ws, sessionId, url) {
  await request(ws, "Page.navigate", { url }, sessionId);
  await wait(1800);
}

async function screenshot(ws, sessionId, name) {
  const shot = await request(ws, "Page.captureScreenshot", { format: "png" }, sessionId);
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(shot.data, "base64"));
}

const REACT_HELPERS = String.raw`
  function rootFiber() {
    const container = document.getElementById("root");
    const key = Object.keys(container).find((name) => name.startsWith("__reactContainer$"));
    if (!key) throw new Error("React container fiber not found");
    const stored = container[key];
    return stored.stateNode?.current || stored.current || stored;
  }
  function componentName(fiber) {
    return fiber?.type?.displayName || fiber?.type?.name || fiber?.elementType?.name || "";
  }
  function findComponent(fiber, wanted) {
    if (!fiber) return null;
    if (componentName(fiber) === wanted) return fiber;
    let child = fiber.child;
    while (child) {
      const match = findComponent(child, wanted);
      if (match) return match;
      child = child.sibling;
    }
    return null;
  }
  function findFiber(fiber, predicate) {
    if (!fiber) return null;
    if (predicate(fiber)) return fiber;
    let child = fiber.child;
    while (child) {
      const match = findFiber(child, predicate);
      if (match) return match;
      child = child.sibling;
    }
    return null;
  }
  function hookAt(fiber, index) {
    let hook = fiber.memoizedState;
    for (let i = 0; i < index; i += 1) hook = hook?.next;
    if (!hook?.queue?.dispatch) throw new Error("React state hook not found at " + index);
    return hook;
  }
`;

async function setWallet(ws, sessionId, starknetAddress, evm) {
  return evaluate(
    ws,
    sessionId,
    `(() => {${REACT_HELPERS}
      const provider = findFiber(rootFiber(), (fiber) => {
        const session = fiber.memoizedState?.memoizedState;
        const evm = fiber.memoizedState?.next?.next?.next?.memoizedState;
        return session && typeof session === "object" &&
          "onExpectedChain" in session && evm && typeof evm === "object" &&
          "status" in evm && "chainId" in evm;
      });
      if (!provider) throw new Error("WalletProvider fiber not found");
      const session = ${
        starknetAddress === null
          ? '{ address: null, chainId: null, identityAddress: null, onExpectedChain: false }'
          : `{ address: ${JSON.stringify(starknetAddress)}, chainId: "0x534e5f4d41494e", identityAddress: null, onExpectedChain: true }`
      };
      const evm = { status: ${JSON.stringify(evm.status)}, address: ${JSON.stringify(evm.address)}, chainId: ${evm.chainId === null ? "null" : `${evm.chainId}n`} };
      hookAt(provider, 0).queue.dispatch(session);
      hookAt(provider, 3).queue.dispatch(evm);
      return { wallet: componentName(provider) };
    })()`,
  );
}

async function setPrizeFacts(ws, sessionId) {
  return evaluate(
    ws,
    sessionId,
    `(() => {${REACT_HELPERS}
      const view = findComponent(rootFiber(), "PrizeSavingsView");
      if (!view) throw new Error("PrizeSavingsView fiber not found");
      hookAt(view, 0).queue.dispatch({
        roundState: "Open",
        participantCount: 3,
        maxParticipants: 16,
        isParticipant: true,
        hasClaimed: false,
        isOwner: true,
        operatorGranted: false,
      });
      hookAt(view, 1).queue.dispatch(false);
      return { view: componentName(view) };
    })()`,
  );
}

async function layout(ws, sessionId) {
  return evaluate(
    ws,
    sessionId,
    `(() => {
      const visible = (el) => el && el.offsetParent !== null && !el.closest('[aria-hidden="true"]');
      const clipped = [...document.querySelectorAll("body *")]
        .filter(visible)
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
        .filter(({ rect }) => rect.left < -1 || rect.right > innerWidth + 1)
        .map(({ el, rect }) => ({
          tag: el.tagName.toLowerCase(),
          cls: typeof el.className === "string" ? el.className.slice(0, 70) : "",
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        }));
      return {
        innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        overflowX: document.documentElement.scrollWidth > innerWidth + 1,
        clipped: clipped.slice(0, 10),
        text: document.body.innerText,
      };
    })()`,
  );
}

async function prizeActions(ws, sessionId) {
  return evaluate(
    ws,
    sessionId,
    `(() => {
      const inputs = [...document.querySelectorAll("input")].filter((el) => el.offsetParent !== null);
      const rows = inputs.map((input) => {
        const row = input.parentElement;
        const button = row?.querySelector("button");
        const ir = input.getBoundingClientRect();
        const br = button?.getBoundingClientRect();
        return {
          placeholder: input.placeholder,
          inputLeft: Math.round(ir.left),
          inputRight: Math.round(ir.right),
          buttonLeft: br ? Math.round(br.left) : null,
          buttonRight: br ? Math.round(br.right) : null,
          wrapped: br ? br.top >= ir.bottom - 1 : null,
          flexWrap: row ? getComputedStyle(row).flexWrap : null,
        };
      });
      return { inputs: inputs.length, rows };
    })()`,
  );
}

const viewports = [
  { name: "320", width: 320, height: 700, mobile: true },
  { name: "mobile-390", width: 390, height: 844, mobile: true },
  { name: "tablet-768", width: 768, height: 1024, mobile: false },
  { name: "desktop-1440", width: 1440, height: 900, mobile: false },
];

const browser = await connect(WS);
for (const viewport of viewports) {
  console.log(`\n=== ${viewport.name} (${viewport.width}x${viewport.height}) ===`);
  const { targetId } = await request(browser, "Target.createTarget", { url: "about:blank" });
  const { sessionId } = await request(
    browser,
    "Target.attachToTarget",
    { targetId, flatten: true },
  );
  await request(
    browser,
    "Emulation.setDeviceMetricsOverride",
    {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.mobile,
    },
    sessionId,
  );
  await request(browser, "Page.enable", {}, sessionId);

  await openPage(browser, sessionId, `${BASE}/`);
  let report = await layout(browser, sessionId);
  check(
    !report.overflowX && report.clipped.length === 0,
    "landing fits viewport",
    JSON.stringify({ overflowX: report.overflowX, clipped: report.clipped }),
  );
  check(!report.text.includes("savings circles, private proof"), "landing bottom island is absent");
  await screenshot(browser, sessionId, `${viewport.name}-landing`);

  await openPage(browser, sessionId, `${BASE}/app`);
  report = await layout(browser, sessionId);
  check(!report.overflowX && report.clipped.length === 0, "disconnected AppShell fits viewport");
  const opened = await evaluate(
    browser,
    sessionId,
    `(() => { const button = [...document.querySelectorAll("button")].find((el) => /^(Connect|Connect to Iwa)$/.test(el.innerText.trim())); if (!button) return false; button.click(); return true; })()`,
  );
  await wait(200);
  const chooser = await evaluate(
    browser,
    sessionId,
    `(() => { const el = document.querySelector('[role="dialog"]'); if (!el) return null; const rect = el.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, text: el.innerText }; })()`,
  );
  check(opened && chooser !== null, "Connect to Iwa chooser opens");
  check(
    chooser && chooser.left >= 0 && chooser.right <= viewport.width && chooser.top >= 0 && chooser.bottom <= viewport.height,
    "chooser stays inside viewport",
  );
  check(chooser && /Starknet/.test(chooser.text) && /EVM/.test(chooser.text), "chooser exposes both wallets");
  await screenshot(browser, sessionId, `${viewport.name}-chooser`);

  await openPage(browser, sessionId, `${BASE}/app`);
  await setWallet(browser, sessionId, "0x04099b8ebd6e6c642b4b31bfd27a9c781", {
    status: "connected",
    address: "0xabcdef1234567890",
    chainId: 11155111,
  });
  await wait(250);
  if (viewport.width < 900) {
    await evaluate(
      browser,
      sessionId,
      `(() => { const button = document.querySelector('button[aria-label="Account"]'); if (!button) return false; button.click(); return true; })()`,
    );
    await wait(150);
  }
  report = await layout(browser, sessionId);
  check(!report.overflowX && report.clipped.length === 0, "dual-wallet AppShell control fits viewport");
  check(/Starknet/.test(report.text) && /EVM/.test(report.text), "AppShell exposes both wallet rows");
  check((report.text.match(/Connected/g) || []).length >= 2, "dual-wallet state shows both connected");
  await screenshot(browser, sessionId, `${viewport.name}-dual-wallet`);

  await openPage(browser, sessionId, `${BASE}/app/prize-savings`);
  await setWallet(browser, sessionId, "0x04099b8ebd6e6c642b4b31bfd27a9c781", {
    status: "disconnected",
    address: null,
    chainId: null,
  });
  await wait(200);
  report = await layout(browser, sessionId);
  check(!report.overflowX && report.clipped.length === 0, "Starknet-only Prize gate fits viewport");
  check(
    report.text.includes("Connect an EVM wallet to use Prize Savings.") &&
      report.text.includes("Your Starknet wallet will stay connected."),
    "Starknet-only gate requests EVM and preserves Starknet copy",
  );
  await screenshot(browser, sessionId, `${viewport.name}-prize-gate`);

  await setWallet(browser, sessionId, null, {
    status: "wrongNetwork",
    address: "0xabcdef1234567890",
    chainId: 1,
  });
  await wait(200);
  report = await layout(browser, sessionId);
  check(
    report.text.includes("Prize Savings currently runs on Ethereum Sepolia.") &&
      report.text.includes("Switch to Sepolia"),
    "wrong EVM network offers Sepolia switch",
  );

  await setWallet(browser, sessionId, null, {
    status: "connected",
    address: "0xabcdef1234567890",
    chainId: 11155111,
  });
  await wait(450);
  await setPrizeFacts(browser, sessionId);
  await wait(100);
  report = await layout(browser, sessionId);
  const actions = await prizeActions(browser, sessionId);
  check(!report.overflowX && report.clipped.length === 0, "EVM-only Prize actions fit viewport");
  check(actions.inputs >= 3, "EVM-only user reaches Prize action layout", `${actions.inputs} inputs`);
  check(
    actions.rows.every((row) =>
      row.inputLeft >= 0 &&
      row.inputRight <= viewport.width &&
      (row.buttonLeft === null || (row.buttonLeft >= 0 && row.buttonRight <= viewport.width)),
    ),
    "Prize input/action rows are not clipped",
  );
  if (viewport.width <= 560) {
    check(actions.rows.every((row) => row.wrapped && row.flexWrap === "wrap"), "Prize actions wrap on narrow screens");
  }
  await screenshot(browser, sessionId, `${viewport.name}-prize-actions`);
}

console.log(`\nScreenshots: ${OUT}`);
if (failures.length) {
  console.error(`\n${failures.length} responsive check(s) failed:`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log("\nAll responsive checks passed.");
process.exit(0);
