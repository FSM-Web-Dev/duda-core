// Duda and AMP Widget Core Library
// Load once, synchronously, from Duda's global Head HTML:
// <script data-categories="essential" src="https://fsm-web-dev.github.io/duda-core/core.js"></script>

(function initializeCore(global) {
    "use strict";

    const CORE_VERSION = 5;

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

    // DOM Ready Helper. Duda already executes custom-widget JavaScript from its
    // own widget-loaded callback, so registering another dmAPI.runOnReady here
    // can miss an event that has already fired and prevent the widget from ever
    // starting. The widget markup is safe to use once the DOM itself is ready.
    const ready = (callback) => {
        let called = false;
        const runOnce = () => {
            if (called) return;
            called = true;
            callback();
        };

        if (global.document.readyState === "loading") {
            global.document.addEventListener("DOMContentLoaded", runOnce, { once: true });
        } else {
            runOnce();
        }
    };

    // X-Frame-Bypass is kept here so iframe widgets do not need a separate
    // script. Browsers without customized built-in support simply keep the
    // normal iframe behavior.
    const registerXFrameBypass = () => {
        if (!global.customElements || typeof global.customElements.define !== "function"
            || typeof global.HTMLIFrameElement !== "function"
            || global.customElements.get("x-frame-bypass")) return;

        try {
            global.customElements.define("x-frame-bypass", class extends global.HTMLIFrameElement {
                static get observedAttributes() {
                    return ["src"];
                }

                attributeChangedCallback() {
                    this.load(this.src);
                }

                connectedCallback() {
                    this.sandbox = "" + this.sandbox || "allow-forms allow-modals allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-scripts allow-top-navigation-by-user-activation";
                }

                load(url, options) {
                    if (!url) return;
                    if (!url.startsWith("http")) throw new Error(`X-Frame-Bypass src ${url} does not start with http(s)://`);

                    this.srcdoc = `<!DOCTYPE html><html><head><style>.loader { position: absolute; top: calc(50% - 25px); left: calc(50% - 25px); width: 50px; height: 50px; background-color: #333; border-radius: 50%; animation: loader 1s infinite ease-in-out; } @keyframes loader { 0% { transform: scale(0); } 100% { transform: scale(1); opacity: 0; } }</style></head><body><div class="loader"></div></body></html>`;

                    this.fetchProxy(url, options, 0).then((response) => response.text()).then((html) => {
                        if (html) this.srcdoc = html.replace(/<head([^>]*)>/i, `<head$1><base href="${url}"><script>document.addEventListener('click', e => { if (frameElement && document.activeElement && document.activeElement.href) { e.preventDefault(); frameElement.load(document.activeElement.href); } }); document.addEventListener('submit', e => { if (frameElement && document.activeElement && document.activeElement.form && document.activeElement.form.action) { e.preventDefault(); if (document.activeElement.form.method === 'post') frameElement.load(document.activeElement.form.action, {method: 'post', body: new FormData(document.activeElement.form)}); else frameElement.load(document.activeElement.form.action + '?' + new URLSearchParams(new FormData(document.activeElement.form))); } });</script>`).replace(/ crossorigin=['"][^'"]*['"]/gi, "");
                    }).catch((error) => console.error("Cannot load X-Frame-Bypass:", error));
                }

                fetchProxy(url, options, index) {
                    const proxies = (options || {}).proxies || [
                        "https://cors-proxy.maximo-ospital-8c9.workers.dev/?",
                        "https://api.allorigins.win/raw?url=",
                        "https://api.codetabs.com/v1/proxy/?quest=",
                        "https://cors-anywhere.herokuapp.com/",
                    ];
                    const proxyUrl = proxies[index] + (index ? encodeURIComponent(url) : url);
                    return global.fetch(proxyUrl, options).then((response) => {
                        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                        return response;
                    }).catch((error) => {
                        if (index === proxies.length - 1) throw error;
                        return this.fetchProxy(url, options, index + 1);
                    });
                }
            }, { extends: "iframe" });
        } catch (error) {
            console.warn("[Core] x-frame-bypass is unavailable:", error);
        }
    };

    registerXFrameBypass();

    // Third-party Dependency Loader
    // Dependencies are registered centrally, loaded only when a widget needs
    // them, and shared across every widget instance on the page.
    const dependencyRegistry = {
        dompurify: {
            src: "https://unpkg.com/dompurify@3.2.4/dist/purify.min.js",
            globalName: "DOMPurify",
        },
        micromodal: {
            src: "https://unpkg.com/micromodal@0.4.10/dist/micromodal.min.js",
            globalName: "MicroModal",
        },
        stripe: {
            src: "https://js.stripe.com/v3/",
            globalName: "Stripe",
        },
        swiper: {
            src: "https://cdn.jsdelivr.net/npm/swiper@11.2.10/swiper-bundle.min.js",
            globalName: "Swiper",
            styles: ["https://cdn.jsdelivr.net/npm/swiper@11.2.10/swiper-bundle.min.css"],
        },
    };
    const dependencyPromises = new Map();
    const stylesheetPromises = new Map();

    const loadStylesheet = (href, dependencyName) => {
        if (stylesheetPromises.has(href)) return stylesheetPromises.get(href);

        const existing = global.document.querySelector(`link[data-core-stylesheet="${dependencyName}"]`)
            || global.document.querySelector(`link[href="${href}"]`);

        const promise = new Promise((resolve, reject) => {
            const link = existing || global.document.createElement("link");
            const succeed = () => resolve(link);
            const fail = () => reject(new Error(`[Core] Failed to load stylesheet for dependency "${dependencyName}": ${href}`));

            if (existing) {
                if (link.sheet) {
                    succeed();
                    return;
                }
                link.addEventListener("load", succeed, { once: true });
                link.addEventListener("error", fail, { once: true });
                return;
            }

            link.rel = "stylesheet";
            link.href = href;
            link.dataset.coreStylesheet = dependencyName;
            link.addEventListener("load", succeed, { once: true });
            link.addEventListener("error", fail, { once: true });
            global.document.head.appendChild(link);
        }).catch((error) => {
            stylesheetPromises.delete(href);
            throw error;
        });

        stylesheetPromises.set(href, promise);
        return promise;
    };

    const loadDependency = (name) => {
        const normalizedName = String(name || "").toLowerCase();
        const definition = dependencyRegistry[normalizedName];

        if (!definition) {
            return Promise.reject(new Error(`[Core] Unknown dependency: "${name}"`));
        }

        if (global[definition.globalName]) {
            return Promise.resolve(global[definition.globalName]);
        }

        if (dependencyPromises.has(normalizedName)) {
            return dependencyPromises.get(normalizedName);
        }

        const promise = Promise.all((definition.styles || []).map((href) => {
            return loadStylesheet(href, normalizedName);
        })).then(() => new Promise((resolve, reject) => {
            const existing = global.document.querySelector(`script[data-core-dependency="${normalizedName}"]`)
                || global.document.querySelector(`script[src="${definition.src}"]`);
            const script = existing || global.document.createElement("script");
            const succeed = () => {
                const dependency = global[definition.globalName];
                if (!dependency) {
                    reject(new Error(`[Core] Dependency "${normalizedName}" loaded without exposing ${definition.globalName}.`));
                    return;
                }
                resolve(dependency);
            };
            const fail = () => reject(new Error(`[Core] Failed to load dependency "${normalizedName}": ${definition.src}`));

            if (global[definition.globalName]) {
                succeed();
                return;
            }

            script.addEventListener("load", succeed, { once: true });
            script.addEventListener("error", fail, { once: true });

            if (!existing) {
                script.src = definition.src;
                script.async = true;
                script.dataset.coreDependency = normalizedName;
                script.dataset.categories = "essential";
                global.document.head.appendChild(script);
            }
        })).catch((error) => {
            dependencyPromises.delete(normalizedName);
            throw error;
        });

        dependencyPromises.set(normalizedName, promise);
        return promise;
    };

    const setLoading = (loaderElement, visible) => {
        if (!loaderElement) return false;

        loaderElement.classList.toggle("hidden", !visible);
        loaderElement.setAttribute("aria-hidden", visible ? "false" : "true");

        if (visible) {
            loaderElement.style.removeProperty("display");
        } else {
            loaderElement.style.display = "none";
        }

        return true;
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
        dependencies: {
            load: loadDependency,
        },
        ui: {
            setLoading,
        },
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
