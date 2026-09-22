(() => {
  const root = typeof globalThis !== "undefined"
    ? globalThis
    : (typeof global !== "undefined" ? global : this);

  const PROBE_GLOBAL = "__tgtProbe";
  const REQUIRE_GLOBAL = "__tgtProbeRequire";

  const api = root[PROBE_GLOBAL] && root[PROBE_GLOBAL].__tgtProbeApi
    ? root[PROBE_GLOBAL]
    : {};

  const state = api.__tgtProbeState || {
    installed: false,
    sequence: 0,
    records: [],
    currentRecord: null,
  };

  root[PROBE_GLOBAL] = api;

  Object.defineProperty(api, "__tgtProbeState", {
    value: state,
    configurable: true,
    enumerable: false,
    writable: false,
  });

  const MAX_RECORDS = 20;
  const LOGIN_PATH = "/api/wx/miniapp/login";
  const MODULE_AUTH = 43;
  const MODULE_REQUEST = 46;
  const MODULE_ENCRYPT = 47;

  const now = () => new Date().toISOString();

  const isTrackedUrl = url => {
    return typeof url === "string" && url.indexOf(LOGIN_PATH) !== -1;
  };

  const safeClone = value => {
    if (value == null) {
      return value;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }

    try {
      return JSON.parse(JSON.stringify(value));
    } catch (error) {
      return String(value);
    }
  };

  const safeParseJson = text => {
    if (typeof text !== "string") {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  };

  const summarizeRecord = record => {
    if (!record) {
      return null;
    }

    return {
      id: record.id,
      createdAt: record.createdAt,
      url: record.url,
      method: record.method,
      authorization: record.authorization,
      plaintextData: safeClone(record.plaintextData),
      aesKey: record.aesKey,
      aesIv: record.aesIv,
      rsaWrappedKey: record.rsaWrappedKey,
      rsaWrappedIv: record.rsaWrappedIv,
      encryptedBody: record.encryptedBody,
      rawResponseStatus: record.rawResponseShell && record.rawResponseShell.status,
      rawResponseMessage: record.rawResponseShell && record.rawResponseShell.message,
      rawResponseDataField: record.rawResponseDataField,
      decryptedResponseJson: safeClone(record.decryptedResponseJson),
      lastError: safeClone(record.lastError),
    };
  };

  const buildSnapshot = () => {
    return {
      installed: !!state.installed,
      installedAt: state.installedAt || null,
      recordCount: state.records.length,
      latestRecord: summarizeRecord(latestRecord()),
      authState: safeClone(state.latestAuthState || null),
    };
  };

  const syncRecoveredAuthState = parsed => {
    if (!parsed || typeof parsed !== "object") {
      return false;
    }

    const nextState = Object.assign({}, state.latestAuthState || {});
    let changed = false;

    if (typeof parsed.token === "string" && parsed.token) {
      nextState.token = parsed.token;
      changed = true;
    }

    if (typeof parsed.refreshToken === "string" && parsed.refreshToken) {
      nextState.refreshToken = parsed.refreshToken;
      changed = true;
    }

    if (!changed) {
      return false;
    }

    state.latestAuthState = nextState;
    return true;
  };

  const trim = collection => {
    if (collection.length > MAX_RECORDS) {
      collection.splice(0, collection.length - MAX_RECORDS);
    }
  };

  const resetProbeState = () => {
    state.sequence = 0;
    state.records = [];
    state.currentRecord = null;
    state.latestAuthState = null;
  };

  const createRecord = initial => {
    state.sequence += 1;
    const record = Object.assign({
      id: "record-" + state.sequence,
      createdAt: now(),
      url: null,
      method: null,
      authorization: null,
      plaintextData: null,
      aesKey: null,
      aesIv: null,
      rsaWrappedKey: null,
      rsaWrappedIv: null,
      encryptedBody: null,
      rawResponseShell: null,
      rawResponseDataField: null,
      decryptedResponseJson: null,
      lastError: null,
    }, initial || {});

    state.records.push(record);
    trim(state.records);
    state.currentRecord = record;
    return record;
  };

  const latestRecord = () => {
    return state.records.length ? state.records[state.records.length - 1] : null;
  };

  const recoverTrackedResponse = (error, record, encryptApi) => {
    if (
      record &&
      record.rawResponseShell &&
      record.rawResponseShell.status === 200 &&
      record.decryptedResponseJson &&
      typeof record.decryptedResponseJson === "object"
    ) {
      record.lastError = null;

      return record.decryptedResponseJson;
    }

    if (
      typeof error !== "string" ||
      !record ||
      !record.rawResponseShell ||
      record.rawResponseShell.status !== 200 ||
      !record.rawResponseShell.data ||
      !record.aesKey ||
      !record.aesIv
    ) {
      throw error;
    }

    try {
      const plaintext = encryptApi.aesDecrypt(record.aesKey, record.aesIv, record.rawResponseShell.data);
      const parsed = safeParseJson(plaintext);

      if (!parsed || typeof parsed !== "object") {
        throw new Error("decrypted payload is not an object");
      }

      record.decryptedResponseJson = parsed;
      record.lastError = null;
      syncRecoveredAuthState(parsed);

      return parsed;
    } catch {
      throw error;
    }
  };

  const updateRecordFromRequestOptions = (record, requestOptions, plaintextData) => {
    if (!record || !requestOptions) {
      return;
    }

    const headers = requestOptions.header || requestOptions.headers || null;
    const requestHeaders = headers ? safeClone(headers) : null;

    record.url = requestOptions.url || record.url;
    record.method = requestOptions.method || record.method || "GET";

    if (plaintextData !== undefined) {
      record.plaintextData = safeClone(plaintextData);
    } else if (record.plaintextData == null && requestOptions.data != null) {
      record.plaintextData = safeClone(requestOptions.data);
    }

    record.authorization = requestHeaders
      ? (requestHeaders.Authorization || requestHeaders.authorization || record.authorization)
      : record.authorization;
    record.aesKey = requestOptions.aesKey || record.aesKey;
    record.aesIv = requestOptions.aesIv || record.aesIv;
    record.rsaWrappedKey = requestHeaders && requestHeaders["AES-KEY"]
      ? requestHeaders["AES-KEY"]
      : record.rsaWrappedKey;
    record.rsaWrappedIv = requestHeaders && requestHeaders["AES-IV"]
      ? requestHeaders["AES-IV"]
      : record.rsaWrappedIv;

    if (requestOptions.data != null) {
      record.encryptedBody = safeClone(requestOptions.data);
    }
  };

  const attachStateHelpers = () => {
    api.reset = () => {
      resetProbeState();
      return Object.assign({ ok: true }, buildSnapshot());
    };

    Object.defineProperty(api, "toJSON", {
      value: () => buildSnapshot(),
      configurable: true,
      enumerable: false,
      writable: true,
    });

    Object.defineProperty(api, "__tgtProbeApi", {
      value: true,
      configurable: true,
      enumerable: false,
      writable: false,
    });
  };

  if (api.__tgtProbeApi) {
    resetProbeState();
  }

  const resolveWebpackJsonpHolder = () => {
    if (typeof global !== "undefined" && global && global.webpackJsonp && typeof global.webpackJsonp.push === "function") {
      return global;
    }

    if (root && root.webpackJsonp && typeof root.webpackJsonp.push === "function") {
      return root;
    }

    if (typeof self !== "undefined" && self && self.webpackJsonp && typeof self.webpackJsonp.push === "function") {
      return self;
    }

    if (typeof window !== "undefined" && window && window.webpackJsonp && typeof window.webpackJsonp.push === "function") {
      return window;
    }

    return null;
  };

  const captureWebpackRequire = () => {
    if (root[REQUIRE_GLOBAL]) {
      return root[REQUIRE_GLOBAL];
    }

    const webpackHolder = resolveWebpackJsonpHolder();

    if (!webpackHolder) {
      throw new Error("webpackJsonp is not available on global/globalThis/self/window");
    }

    const probeId = "tgt-auth-probe-runtime";
    root[REQUIRE_GLOBAL] = null;

    webpackHolder.webpackJsonp.push([
      [probeId],
      {
        [probeId]: function(module, exports, __webpack_require__) {
          root[REQUIRE_GLOBAL] = __webpack_require__;
        },
      },
      [[probeId]],
    ]);

    if (!root[REQUIRE_GLOBAL]) {
      throw new Error("failed to capture webpack require");
    }

    return root[REQUIRE_GLOBAL];
  };

  const wrapMethod = (holder, key, wrapperFactory) => {
    if (!holder || typeof holder[key] !== "function") {
      return false;
    }

    const original = holder[key];
    if (original.__tgtProbeWrapped) {
      return true;
    }

    const wrapped = wrapperFactory(original);
    wrapped.__tgtProbeWrapped = true;
    wrapped.__tgtProbeOriginal = original;
    holder[key] = wrapped;
    return true;
  };

  const unwrapMethod = (holder, key) => {
    if (!holder || typeof holder[key] !== "function") {
      return false;
    }

    const current = holder[key];
    if (!current.__tgtProbeWrapped || typeof current.__tgtProbeOriginal !== "function") {
      return false;
    }

    holder[key] = current.__tgtProbeOriginal;
    return true;
  };

  const patchRequestApi = requestApi => {
    if (!requestApi || typeof requestApi.request !== "function") {
      return false;
    }

    return wrapMethod(requestApi, "request", originalRequest => function wrappedRequest(options) {
      if (!options || !isTrackedUrl(options.url)) {
        return originalRequest.apply(this, arguments);
      }

      const record = state.currentRecord || createRecord();
      updateRecordFromRequestOptions(record, options);

      const originalSuccess = options.success;
      const originalFail = options.fail;

      options.success = response => {
        record.rawResponseShell = safeClone(response && response.data ? response.data : response);
        record.rawResponseDataField = response && response.data ? safeClone(response.data.data) : null;
        if (state.currentRecord === record) {
          state.currentRecord = null;
        }

        if (typeof originalSuccess === "function") {
          return originalSuccess.apply(this, arguments);
        }

        return undefined;
      };

      options.fail = error => {
        record.lastError = safeClone(error);
        if (state.currentRecord === record) {
          state.currentRecord = null;
        }

        if (typeof originalFail === "function") {
          return originalFail.apply(this, arguments);
        }

        return undefined;
      };

      return originalRequest.call(this, options);
    });
  };

  const patchGlobalRequestApis = () => {
    patchRequestApi(root.uni);
    patchRequestApi(root.wx);
  };

  const patchAuthApi = authApi => {
    if (!authApi) {
      return false;
    }

    let patched = false;

    patched = wrapMethod(authApi, "setToken", originalSetToken => function wrappedSetToken(value) {
      state.latestAuthState = Object.assign({}, state.latestAuthState || {}, {
        token: value,
      });
      return originalSetToken.apply(this, arguments);
    }) || patched;

    patched = wrapMethod(authApi, "setRefreshToken", originalSetRefreshToken => function wrappedSetRefreshToken(value) {
      state.latestAuthState = Object.assign({}, state.latestAuthState || {}, {
        refreshToken: value,
      });
      return originalSetRefreshToken.apply(this, arguments);
    }) || patched;

    patched = wrapMethod(authApi, "removeToken", originalRemoveToken => function wrappedRemoveToken() {
      state.latestAuthState = Object.assign({}, state.latestAuthState || {}, {
        token: null,
      });
      return originalRemoveToken.apply(this, arguments);
    }) || patched;

    patched = wrapMethod(authApi, "getToken", originalGetToken => function wrappedGetToken() {
      const value = originalGetToken.apply(this, arguments);
      state.latestAuthState = Object.assign({}, state.latestAuthState || {}, {
        token: value,
      });
      return value;
    }) || patched;

    patched = wrapMethod(authApi, "getRefreshToken", originalGetRefreshToken => function wrappedGetRefreshToken() {
      const value = originalGetRefreshToken.apply(this, arguments);
      state.latestAuthState = Object.assign({}, state.latestAuthState || {}, {
        refreshToken: value,
      });
      return value;
    }) || patched;

    return patched;
  };

  {
    const webpackRequire = captureWebpackRequire();
    const authModule = webpackRequire(MODULE_AUTH);
    const requestModule = webpackRequire(MODULE_REQUEST);
    const encryptModule = webpackRequire(MODULE_ENCRYPT);
    const authApi = authModule && (authModule.default || authModule);
    const encryptApi = encryptModule && (encryptModule.default || encryptModule);

    if (!authApi) {
      throw new Error("auth module 43 is not available");
    }

    if (!requestModule || typeof requestModule.default !== "function") {
      throw new Error("request module 46 is not available");
    }

    if (!encryptApi) {
      throw new Error("encrypt module 47 is not available");
    }

    unwrapMethod(authApi, "getToken");
    unwrapMethod(authApi, "setToken");
    unwrapMethod(authApi, "removeToken");
    unwrapMethod(authApi, "getRefreshToken");
    unwrapMethod(authApi, "setRefreshToken");
    unwrapMethod(requestModule, "default");
    unwrapMethod(root.uni, "request");
    unwrapMethod(root.wx, "request");

    patchAuthApi(authApi);

    wrapMethod(requestModule, "default", originalRequest => function wrappedModuleRequest(requestOptions) {
      if (!requestOptions || !isTrackedUrl(requestOptions.url)) {
        return originalRequest.apply(this, arguments);
      }

      const plaintextData = requestOptions.data != null ? safeClone(requestOptions.data) : null;
      const record = createRecord({
        url: requestOptions.url,
        method: requestOptions.method || "GET",
        plaintextData,
      });

      let result;

      try {
        result = originalRequest.apply(this, arguments);
      } catch (error) {
        updateRecordFromRequestOptions(record, requestOptions, plaintextData);
        record.lastError = safeClone(error);

        if (state.currentRecord === record) {
          state.currentRecord = null;
        }

        throw error;
      }

      updateRecordFromRequestOptions(record, requestOptions, plaintextData);

      if (!result || typeof result.then !== "function") {
        if (state.currentRecord === record) {
          state.currentRecord = null;
        }

        return result;
      }

      return result.then(value => {
        updateRecordFromRequestOptions(record, requestOptions, plaintextData);

        if (value && typeof value === "object") {
          record.decryptedResponseJson = safeClone(value);
          record.lastError = null;
          syncRecoveredAuthState(value);
        } else if (typeof value === "string") {
          const parsed = safeParseJson(value);

          if (parsed && typeof parsed === "object") {
            record.decryptedResponseJson = parsed;
            record.lastError = null;
            syncRecoveredAuthState(parsed);
          }
        }

        if (state.currentRecord === record) {
          state.currentRecord = null;
        }

        return value;
      }, error => {
        try {
          updateRecordFromRequestOptions(record, requestOptions, plaintextData);
          record.lastError = safeClone(error);
          return recoverTrackedResponse(error, record, encryptApi);
        } finally {
          if (state.currentRecord === record) {
            state.currentRecord = null;
          }
        }
      });
    });

    patchGlobalRequestApis();

    state.installed = true;
    state.installedAt = now();
    state.latestAuthState = Object.assign({}, state.latestAuthState || {}, {
      token: typeof authApi.getToken === "function" ? authApi.getToken() : null,
      refreshToken: typeof authApi.getRefreshToken === "function" ? authApi.getRefreshToken() : null,
    });

    attachStateHelpers();
  }

  return JSON.stringify(buildSnapshot());
})();