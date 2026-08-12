// Duda and AMP Widget Core Library
// To be imported from https://fsm-web-dev.github.io/duda-core/core.js

(function initializeCore(global) {
    "use strict";

    const CORE_VERSION = 2;

    // A page can contain several widgets, each of which may import this classic
    // script. Do not recreate stateful helpers (especially the consent promise)
    // when the same release is evaluated more than once.
    if (global.Core && global.Core.__safeFoundationVersion === CORE_VERSION) {
        return;
    }

    const existingCore = global.Core || {};

    // Store
    const createStore = existingCore.createStore || ((initialState = {}) => {
        let state = { ...initialState };
        const listeners = {};

        return {
            getState() {
                return state;
            },

            get(key) {
                return state[key];
            },

            set(key, value) {
                state[key] = value;

                if (listeners[key]) {
                    listeners[key].forEach((callback) => callback(value, state));
                }
            },

            update(payload = {}) {
                Object.entries(payload).forEach(([key, value]) => {
                    this.set(key, value);
                });
            },

            subscribe(key, callback) {
                if (!listeners[key]) {
                    listeners[key] = [];
                }

                listeners[key].push(callback);
            },
        };
    });

    // Storage Wrapper
    const createStorage = (getStorage) => ({
        get(key, fallback = null) {
            try {
                const value = getStorage().getItem(key);
                return value === null ? fallback : JSON.parse(value);
            } catch (error) {
                console.error(error);
                return fallback;
            }
        },

        set(key, value) {
            try {
                getStorage().setItem(key, JSON.stringify(value));
            } catch (error) {
                console.error(error);
            }
        },

        remove(key) {
            try {
                getStorage().removeItem(key);
            } catch (error) {
                console.error(error);
            }
        },

        clear() {
            try {
                getStorage().clear();
            } catch (error) {
                console.error(error);
            }
        },
    });

    // API Request Wrapper (kept backward-compatible; consent.fetch below
    // deliberately returns the native Response instead).
    const request = existingCore.request || (async (url, options = {}) => {
        try {
            const response = await global.fetch(url, {
                headers: {
                    "Content-Type": "application/json",
                },
                ...options,
            });

            if (!response.ok) {
                throw new Error(`HTTP Error ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error(error);

            return {
                error: true,
                message: error.message,
            };
        }
    });

    // Event Delegation Helper
    const delegate = existingCore.delegate || ((eventType, selector, handler, parent = global.document) => {
        parent.addEventListener(eventType, async (event) => {
            const target = event.target.closest(selector);

            if (!target) return;

            await handler(event, target);
        });
    });

    // DOM Caching Helper
    const cacheDOM = existingCore.cacheDOM || ((selectors) => {
        return Object.entries(selectors).reduce((acc, [key, selector]) => {
            acc[key] = global.document.querySelector(selector);
            return acc;
        }, {});
    });

    // Text Helpers
    const slugify = existingCore.slugify || ((text) => {
        return text
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
    });

    const escapeHtml = (value) => {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    };

    const RICH_HTML_ALLOWED_TAGS = [
        "div", "p", "span", "ul", "li", "img", "svg", "path", "br", "strong", "em",
    ];
    const RICH_HTML_ALLOWED_ATTR = [
        "class", "src", "alt", "style", "viewBox", "xmlns", "d", "fill",
    ];

    const sanitizeRich = (html) => {
        if (!global.DOMPurify || typeof global.DOMPurify.sanitize !== "function") {
            console.error("[Core] DOMPurify is not loaded — refusing to render rich HTML unsanitized.");
            return "";
        }

        return global.DOMPurify.sanitize(html, {
            ALLOWED_TAGS: RICH_HTML_ALLOWED_TAGS,
            ALLOWED_ATTR: RICH_HTML_ALLOWED_ATTR,
        });
    };

    // Geospatial Helpers
    const haversineMiles = (lat1, lon1, lat2, lon2) => {
        const R = 3958.8;
        const toRad = (deg) => deg * (Math.PI / 180);
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) ** 2
            + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2))
            * Math.sin(dLon / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return R * c;
    };

    // Consent Helpers
    let consentDecisionPromise = null;

    // Duda checkbox values can be booleans or strings. An omitted setting
    // remains enabled so existing widget instances keep their current behavior.
    const isTermlyEnabled = (value) => {
        return value !== false && value !== "false" && value !== 0 && value !== "0";
    };

    const waitForDecision = (options = {}) => {
        if (!isTermlyEnabled(options.waitForTermly)) {
            return Promise.resolve();
        }

        if (consentDecisionPromise) {
            return consentDecisionPromise;
        }

        const selector = options.selector || ".t-consentPrompt";
        const graceMs = options.graceMs ?? 3000;
        const pollMs = options.pollMs ?? 300;
        const timeoutMs = options.timeoutMs ?? 60000;

        consentDecisionPromise = new Promise((resolve) => {
            let settled = false;
            let sawBanner = false;
            let graceElapsed = false;
            let observer = null;
            let poll = null;
            let grace = null;
            let timeout = null;

            const isBannerVisible = () => {
                const element = global.document.querySelector(selector);
                if (!element) return false;

                const style = global.getComputedStyle(element);
                if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) {
                    return false;
                }

                const rect = element.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            };

            const finish = () => {
                if (settled) return;
                settled = true;

                if (observer) observer.disconnect();
                if (poll !== null) global.clearInterval(poll);
                if (grace !== null) global.clearTimeout(grace);
                if (timeout !== null) global.clearTimeout(timeout);
                resolve();
            };

            const check = () => {
                if (isBannerVisible()) {
                    sawBanner = true;
                    return;
                }

                if (sawBanner || graceElapsed) finish();
            };

            check();

            const observationRoot = global.document.body || global.document.documentElement;
            if (observationRoot && typeof global.MutationObserver === "function") {
                observer = new global.MutationObserver(check);
                observer.observe(observationRoot, { attributes: true, childList: true, subtree: true });
            }

            poll = global.setInterval(check, pollMs);
            grace = global.setTimeout(() => {
                graceElapsed = true;
                check();
            }, graceMs);
            timeout = global.setTimeout(finish, timeoutMs);
        });

        return consentDecisionPromise;
    };

    const consentFetch = async (url, options = {}) => {
        const { waitForTermly, ...fetchOptions } = options;

        await waitForDecision({ waitForTermly });
        return global.fetch(url, fetchOptions);
    };

    const hasConsentCategory = async (category, options = {}) => {
        if (!isTermlyEnabled(options.waitForTermly)) {
            return true;
        }

        if (!global.Termly || typeof global.Termly.getConsentState !== "function") {
            return false;
        }

        try {
            const state = await global.Termly.getConsentState();
            return state?.[category] === true;
        } catch (error) {
            console.error("[Core] Error reading Termly consent state:", error);
            return false;
        }
    };

    // Duda/DOM Ready Helper
    const ready = (callback) => {
        let called = false;
        const runOnce = () => {
            if (called) return;
            called = true;
            callback();
        };

        if (global.dmAPI && typeof global.dmAPI.runOnReady === "function") {
            global.dmAPI.runOnReady(runOnce);
        } else if (global.document.readyState === "loading") {
            global.document.addEventListener("DOMContentLoaded", runOnce, { once: true });
        } else {
            runOnce();
        }
    };

    const Core = {
        ...existingCore,
        createStore,
        request,
        delegate,
        cacheDOM,
        slugify,
        // Preserve the original flat helper while making the unit explicit in
        // the new namespace.
        haversine: existingCore.haversine || haversineMiles,
        ready,
        Storage: {
            local: createStorage(() => global.localStorage),
            session: createStorage(() => global.sessionStorage),
        },
        consent: {
            isEnabled: isTermlyEnabled,
            waitForDecision,
            fetch: consentFetch,
            hasCategory: hasConsentCategory,
        },
        html: {
            escape: escapeHtml,
            sanitizeRich,
        },
        geo: {
            haversineMiles,
        },
    };

    Object.defineProperty(Core, "__safeFoundationVersion", {
        value: CORE_VERSION,
        enumerable: false,
    });

    global.Core = Core;
})(window);
