const Core = (() => {
    // Store
    const createStore = (initialState = {}) => {
        let state = { ...initialState, };

        const listeners = {};

        return {
            getState() {
                return state;
            },

            get(key) {
                return state[key];
            },

            set(key, value) {
                // Update state
                state[key] = value;

                // Trigger subscribed listeners
                if (listeners[key]) {
                    listeners[key].forEach((callback) => { 
                            callback(value, state);
                        }
                    );
                }
            },

            update(payload = {}) {
                Object.entries(payload).forEach(
                    ([key, value]) => {
                        this.set(key, value);
                    }
                );
            },

            subscribe(key, callback) {
                if (!listeners[key]) {
                    listeners[key] = [];
                }

                listeners[key].push(callback);
            },
        };
    };

    // Storage Wrapper
    const createStorage = (storage) => ({
        get(key, fallback = null) {
            try {
                const value = storage.getItem(key);

                return value
                    ? JSON.parse(value)
                    : fallback;
            } catch (error) {
                console.error(error);
                return fallback;
            }
        },

        set(key, value) {
            try {
                storage.setItem(key, JSON.stringify(value));
            } catch (error) {
                console.error(error);
            }
        },

        remove(key) {
            storage.removeItem(key);
        },

        clear() {
            storage.clear();
        },
    });

    // API Request Wrapper
    const request = async (url, options = {}) => {
        try {
            const response =
                await fetch(url, {
                    headers: {
                        "Content-Type":
                            "application/json",
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
    };

    // Event Delegation Helper
    const delegate = (eventType, selector, handler, parent = document) => {
        parent.addEventListener(
            eventType,
            async (event) => {
                const target = event.target.closest(selector);

                if (!target) return;

                await handler(event, target);
            }
        );
    };

    // DOM Caching Helper
    const cacheDOM = (selectors) => {
        return Object.entries(selectors).reduce((acc, [key, selector]) => {
                acc[key] = document.querySelector(selector);

                return acc;
            },
            {}
        );
    };

    // Text Helpers
    const slugify = (text) => {
        return text
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
    };

    const haversine = (lat1, lon1, lat2, lon2) => {
        const R = 3958.8;

        const toRad = (deg) => deg * (Math.PI / 180);

        const dLat = toRad(lat2 - lat1);

        const dLon = toRad(lon2 - lon1);

        const a = Math.sin(dLat / 2) **  2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return R * c;
    };

    const ready = (callback) => {
        if (window.dmAPI) {
            window.dmAPI.runOnReady(callback);
        } else {
            document.addEventListener("DOMContentLoaded", callback);
        }
    };

    return {
        createStore,
        request,
        delegate,
        cacheDOM,
        slugify,
        haversine,
        ready,
        Storage: {
            local: createStorage(localStorage),
            session: createStorage(sessionStorage),
        },
    };
})();