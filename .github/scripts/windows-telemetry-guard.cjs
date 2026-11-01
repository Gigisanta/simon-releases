"use strict";

// Serialized into the installed WebView, never into a replacement browser.
// Only this endpoint/method is rejected; auth, chat and consent are delegated.
function installTelemetryGuard(bootId) {
  const marker = Symbol.for("simon.qa.telemetry.guard.v1");
  if (window[marker]) {
    const current = window[marker]();
    if (current.bootId !== bootId || !current.fetchGuarded || !current.bridgeArmed) throw new Error("telemetry_guard_changed");
    return current;
  }
  if (Object.hasOwn(window, "__TAURI_INTERNALS__")) throw new Error("telemetry_bridge_preexisting");
  const define = Object.defineProperty;
  const defines = Object.defineProperties;
  const reflectDefine = Reflect.defineProperty;
  const apply = Reflect.apply;
  const wrappedInvokes = new WeakSet();
  const proxies = new WeakSet();
  let fetchBlocked = 0;
  let invokeBlocked = 0;
  let internal;
  let bridgeArmed = false;
  const denied = () => Promise.reject(new DOMException("QA section-view excluded", "AbortError"));
  function selected(input, method) {
    if (String(method ?? "GET").toUpperCase() !== "POST") return false;
    let url;
    try { url = new URL(input, window.location.href); } catch { return false; }
    return url.origin === "https://simon.maat.work" && url.pathname === "/api/telemetry/section-view";
  }
  const originalFetch = window.fetch;
  if (typeof originalFetch !== "function") throw new Error("telemetry_fetch_missing");
  function guardedFetch(input, init) {
    const request = typeof Request !== "undefined" && input instanceof Request;
    const url = request ? input.url : typeof input === "string" || input instanceof URL ? String(input) : null;
    if (url !== null && selected(url, init?.method ?? (request ? input.method : "GET"))) {
      fetchBlocked += 1;
      return denied();
    }
    return apply(originalFetch, this, arguments);
  }
  function guardedInvoke(fn) {
    if (typeof fn !== "function") throw new Error("telemetry_invoke_invalid");
    if (wrappedInvokes.has(fn)) return fn;
    const wrapped = function (command, args) {
      if (command === "plugin:http|fetch" && selected(args?.clientConfig?.url, args?.clientConfig?.method)) {
        invokeBlocked += 1;
        return denied(); // No Rust request resource is allocated or sent.
      }
      return apply(fn, this, arguments);
    };
    wrappedInvokes.add(wrapped);
    return wrapped;
  }
  function bridge(value) {
    if (value === null || typeof value !== "object") throw new Error("telemetry_bridge_invalid");
    if (proxies.has(value)) return value;
    const existing = Object.getOwnPropertyDescriptor(value, "invoke");
    if (existing) {
      if (!("value" in existing) || (!existing.configurable && !existing.writable)) throw new Error("telemetry_invoke_preexisting");
      define(value, "invoke", { ...existing, value: guardedInvoke(existing.value) });
    }
    const proxy = new Proxy(value, {
      defineProperty(target, key, descriptor) {
        if (key === "invoke") {
          if (!("value" in descriptor)) throw new Error("telemetry_invoke_accessor_unsupported");
          descriptor = { ...descriptor, value: guardedInvoke(descriptor.value) };
        }
        return reflectDefine(target, key, descriptor);
      },
      set(target, key, next, receiver) {
        return Reflect.set(target, key, key === "invoke" ? guardedInvoke(next) : next, receiver);
      },
    });
    proxies.add(proxy);
    return proxy;
  }
  function guardedDescriptor(target, key, descriptor) {
    // Transform BEFORE native Object/Reflect define calls. Returning a changed
    // frozen value only from Proxy.defineProperty would violate its invariants.
    if (key === "invoke" && proxies.has(target)) {
      if (!("value" in descriptor)) throw new Error("telemetry_invoke_accessor_unsupported");
      return { ...descriptor, value: guardedInvoke(descriptor.value) };
    }
    if (target !== window || key !== "__TAURI_INTERNALS__") return descriptor;
    if (!("value" in descriptor)) throw new Error("telemetry_bridge_accessor_unsupported");
    return { configurable: false, enumerable: false, writable: false, ...descriptor, value: bridge(descriptor.value) };
  }
  // Tauri defines invoke as non-configurable/non-writable. Arm its *creation*,
  // including Object.defineProperty and ordinary assignment, rather than trying
  // to monkey-patch the frozen function after app startup.
  define(window, "__TAURI_INTERNALS__", {
    configurable: true, enumerable: false,
    get: () => internal,
    set: (value) => { internal = bridge(value); },
  });
  Object.defineProperty = function (target, key, descriptor) {
    return define(target, key, guardedDescriptor(target, key, descriptor));
  };
  Reflect.defineProperty = function (target, key, descriptor) {
    return reflectDefine(target, key, guardedDescriptor(target, key, descriptor));
  };
  Object.defineProperties = function (target, descriptors) {
    const key = target === window && Object.hasOwn(descriptors, "__TAURI_INTERNALS__") ? "__TAURI_INTERNALS__" :
      proxies.has(target) && Object.hasOwn(descriptors, "invoke") ? "invoke" : null;
    if (key !== null) descriptors = { ...descriptors, [key]: guardedDescriptor(target, key, descriptors[key]) };
    return defines(target, descriptors);
  };
  const fetchDescriptor = Object.getOwnPropertyDescriptor(window, "fetch");
  define(window, "fetch", { configurable: true, enumerable: true, writable: true, ...fetchDescriptor, value: guardedFetch });
  bridgeArmed = true;
  const snapshot = () => ({
    schema: "simon-telemetry-guard/v1", bootId,
    fetchGuarded: window.fetch === guardedFetch, bridgeArmed,
    bridgeGuarded: proxies.has(window.__TAURI_INTERNALS__) && wrappedInvokes.has(window.__TAURI_INTERNALS__?.invoke),
    fetchBlocked, invokeBlocked,
  });
  define(window, marker, { value: snapshot, configurable: false, enumerable: false, writable: false });
  return snapshot();
}

function telemetrySource(bootId) {
  return `(${installTelemetryGuard.toString()})(${JSON.stringify(bootId)})\n//# sourceURL=simon-qa://telemetry-guard`;
}
module.exports = { installTelemetryGuard, telemetrySource };
