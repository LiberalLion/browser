/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* exported ProductAddonChecker */

var EXPORTED_SYMBOLS = ["ProductAddonChecker"];

const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);
const { Log } = ChromeUtils.import("resource://gre/modules/Log.jsm");
const { CertUtils } = ChromeUtils.import(
  "resource://gre/modules/CertUtils.jsm"
);
const { OS } = ChromeUtils.import("resource://gre/modules/osfile.jsm");

XPCOMUtils.defineLazyGlobalGetters(this, ["XMLHttpRequest"]);

// This exists so that tests can override the XHR behaviour for downloading
// the addon update XML file.
var CreateXHR = function() {
  return new XMLHttpRequest();
};

var logger = Log.repository.getLogger("addons.productaddons");

/**
 * Number of milliseconds after which we need to cancel `downloadXML`.
 *
 * Bug 1087674 suggests that the XHR we use in `downloadXML` may
 * never terminate in presence of network nuisances (e.g. strange
 * antivirus behavior). This timeout is a defensive measure to ensure
 * that we fail cleanly in such case.
 */
const TIMEOUT_DELAY_MS = 20000;
// How much of a file to read into memory at a time for hashing
const HASH_CHUNK_SIZE = 8192;

/**
 * Gets the status of an XMLHttpRequest either directly or from its underlying
 * channel.
 *
 * @param  request
 *         The XMLHttpRequest.
 * @return an integer status value.
 */
function getRequestStatus(request) {
  let status = null;
  try {
    status = request.status;
  } catch (e) {}

  if (status != null) {
    return status;
  }

  return request.channel.QueryInterface(Ci.nsIRequest).status;
}

/**
 * Downloads an XML document from a URL optionally testing the SSL certificate
 * for certain attributes.
 *
 * @param  url
 *         The url to download from.
 * @param  allowNonBuiltIn
 *         Whether to trust SSL certificates without a built-in CA issuer.
 * @param  allowedCerts
 *         The list of certificate attributes to match the SSL certificate
 *         against or null to skip checks.
 * @return a promise that resolves to the DOM document downloaded or rejects
 *         with a JS exception in case of error.
 */
function downloadXML(url, allowNonBuiltIn = false, allowedCerts = null) {
  return new Promise((resolve, reject) => {
    let request = CreateXHR();
    // This is here to let unit test code override XHR
    if (request.wrappedJSObject) {
      request = request.wrappedJSObject;
    }
    request.open("GET", url, true);
    request.channel.notificationCallbacks = new CertUtils.BadCertHandler(
      allowNonBuiltIn
    );
    // Prevent the request from reading from the cache.
    request.channel.loadFlags |= Ci.nsIRequest.LOAD_BYPASS_CACHE;
    // Prevent the request from writing to the cache.
    request.channel.loadFlags |= Ci.nsIRequest.INHIBIT_CACHING;
    // Don't send any cookies
    request.channel.loadFlags |= Ci.nsIRequest.LOAD_ANONYMOUS;
    // Use conservative TLS settings. See bug 1325501.
    // TODO move to ServiceRequest.
    if (request.channel instanceof Ci.nsIHttpChannelInternal) {
      request.channel.QueryInterface(
        Ci.nsIHttpChannelInternal
      ).beConservative = true;
    }
    request.timeout = TIMEOUT_DELAY_MS;

    request.overrideMimeType("text/xml");
    // The Cache-Control header is only interpreted by proxies and the
    // final destination. It does not help if a resource is already
    // cached locally.
    request.setRequestHeader("Cache-Control", "no-cache");
    // HTTP/1.0 servers might not implement Cache-Control and
    // might only implement Pragma: no-cache
    request.setRequestHeader("Pragma", "no-cache");

    let fail = event => {
      let request = event.target;
      let status = getRequestStatus(request);
      let message =
        "Failed downloading XML, status: " + status + ", reason: " + event.type;
      logger.warn(message);
      let ex = new Error(message);
      ex.status = status;
      reject(ex);
    };

    let success = event => {
      logger.info("Completed downloading document");
      let request = event.target;

      try {
        CertUtils.checkCert(request.channel, allowNonBuiltIn, allowedCerts);
      } catch (ex) {
        logger.error("Request failed certificate checks: " + ex);
        ex.status = getRequestStatus(request);
        reject(ex);
        return;
      }

      resolve(request.responseXML);
    };

    request.addEventListener("error", fail);
    request.addEventListener("abort", fail);
    request.addEventListener("timeout", fail);
    request.addEventListener("load", success);

    logger.info("sending request to: " + url);
    request.send(null);
  });
}

/**
 * Parses a list of add-ons from a DOM document.
 *
 * @param  document
 *         The DOM document to parse.
 * @return null if there is no <addons> element otherwise an object containing
 *         an array of the addons listed and a field notifying whether the
 *         fallback was used.
 */
function parseXML(document) {
  // Check that the root element is correct
  if (document.documentElement.localName != "updates") {
    throw new Error(
      "got node name: " +
        document.documentElement.localName +
        ", expected: updates"
    );
  }

  // Check if there are any addons elements in the updates element
  let addons = document.querySelector("updates:root > addons");
  if (!addons) {
    return null;
  }

  let results = [];
  let addonList = document.querySelectorAll("updates:root > addons > addon");
  for (let addonElement of addonList) {
    let addon = {};

    for (let name of [
      "id",
      "URL",
      "hashFunction",
      "hashValue",
      "version",
      "size",
    ]) {
      if (addonElement.hasAttribute(name)) {
        addon[name] = addonElement.getAttribute(name);
      }
    }
    addon.size = Number(addon.size) || undefined;

    results.push(addon);
  }

  return {
    usedFallback: false,
    addons: results,
  };
}

/**
 * Downloads file from a URL using XHR.
 *
 * @param  url
 *         The url to download from.
 * @param  options (optional)
 * @param  options.httpsOnlyNoUpgrade
 *         Prevents upgrade to https:// when HTTPS-Only Mode is enabled.
 * @return a promise that resolves to the path of a temporary file or rejects
 *         with a JS exception in case of error.
 */
function downloadFile(url, options = { httpsOnlyNoUpgrade: false }) {
  return new Promise((resolve, reject) => {
    let xhr = new XMLHttpRequest();

    xhr.onload = function(response) {
      logger.info("downloadXHR File download. status=" + xhr.status);
      if (xhr.status != 200 && xhr.status != 206) {
        reject(Components.Exception("File download failed", xhr.status));
        return;
      }
      (async function() {
        let f = await OS.File.openUnique(
          OS.Path.join(OS.Constants.Path.tmpDir, "tmpaddon")
        );
        let path = f.path;
        logger.info(`Downloaded file will be saved to ${path}`);
        await f.file.close();
        await OS.File.writeAtomic(path, new Uint8Array(xhr.response));
        return path;
      })().then(resolve, reject);
    };

    let fail = event => {
      let request = event.target;
      let status = getRequestStatus(request);
      let message =
        "Failed downloading via XHR, status: " +
        status +
        ", reason: " +
        event.type;
      logger.warn(message);
      let ex = new Error(message);
      ex.status = status;
      reject(ex);
    };
    xhr.addEventListener("error", fail);
    xhr.addEventListener("abort", fail);

    xhr.responseType = "arraybuffer";
    try {
      xhr.open("GET", url);
      if (options.httpsOnlyNoUpgrade) {
        xhr.channel.loadInfo.httpsOnlyStatus |=
          Ci.nsILoadInfo.HTTPS_ONLY_EXEMPT;
      }
      // Allow deprecated HTTP request from SystemPrincipal
      xhr.channel.loadInfo.allowDeprecatedSystemRequests = true;
      // Use conservative TLS settings. See bug 1325501.
      // TODO move to ServiceRequest.
      if (xhr.channel instanceof Ci.nsIHttpChannelInternal) {
        xhr.channel.QueryInterface(
          Ci.nsIHttpChannelInternal
        ).beConservative = true;
      }
      xhr.send(null);
    } catch (ex) {
      reject(ex);
    }
  });
}

/**
 * Convert a string containing binary values to hex.
 */
function binaryToHex(input) {
  let result = "";
  for (let i = 0; i < input.length; ++i) {
    let hex = input.charCodeAt(i).toString(16);
    if (hex.length == 1) {
      hex = "0" + hex;
    }
    result += hex;
  }
  return result;
}

/**
 * Calculates the hash of a file.
 *
 * @param  hashFunction
 *         The type of hash function to use, must be supported by nsICryptoHash.
 * @param  path
 *         The path of the file to hash.
 * @return a promise that resolves to hash of the file or rejects with a JS
 *         exception in case of error.
 */
var computeHash = async function(hashFunction, path) {
  let file = await OS.File.open(path, { existing: true, read: true });
  try {
    let hasher = Cc["@mozilla.org/security/hash;1"].createInstance(
      Ci.nsICryptoHash
    );
    hasher.initWithString(hashFunction);

    let bytes;
    do {
      bytes = await file.read(HASH_CHUNK_SIZE);
      hasher.update(bytes, bytes.length);
    } while (bytes.length == HASH_CHUNK_SIZE);

    return binaryToHex(hasher.finish(false));
  } finally {
    await file.close();
  }
};

/**
 * Verifies that a downloaded file matches what was expected.
 *
 * @param  properties
 *         The properties to check, `hashFunction` with `hashValue`
 *         are supported. Any properties missing won't be checked.
 * @param  path
 *         The path of the file to check.
 * @return a promise that resolves if the file matched or rejects with a JS
 *         exception in case of error.
 */
var verifyFile = async function(properties, path) {
  if (properties.size !== undefined) {
    let stat = await OS.File.stat(path);
    if (stat.size != properties.size) {
      throw new Error(
        "Downloaded file was " +
          stat.size +
          " bytes but expected " +
          properties.size +
          " bytes."
      );
    }
  }

  if (properties.hashFunction !== undefined) {
    let expectedDigest = properties.hashValue.toLowerCase();
    let digest = await computeHash(properties.hashFunction, path);
    if (digest != expectedDigest) {
      throw new Error(
        "Hash was `" + digest + "` but expected `" + expectedDigest + "`."
      );
    }
  }
};

const ProductAddonChecker = {
  /**
   * Downloads a list of add-ons from a URL optionally testing the SSL
   * certificate for certain attributes.
   *
   * @param  url
   *         The url to download from.
   * @param  allowNonBuiltIn
   *         Whether to trust SSL certificates without a built-in CA issuer.
   * @param  allowedCerts
   *         The list of certificate attributes to match the SSL certificate
   *         against or null to skip checks.
   * @return a promise that resolves to an object containing the list of add-ons
   *         and whether the local fallback was used, or rejects with a JS
   *         exception in case of error.
   */
  getProductAddonList(url, allowNonBuiltIn = false, allowedCerts = null) {
    return downloadXML(url, allowNonBuiltIn, allowedCerts).then(parseXML);
  },

  /**
   * Downloads an add-on to a local file and checks that it matches the expected
   * file. The caller is responsible for deleting the temporary file returned.
   *
   * @param  addon
   *         The addon to download.
   * @param  options (optional)
   * @param  options.httpsOnlyNoUpgrade
   *         Prevents upgrade to https:// when HTTPS-Only Mode is enabled.
   * @return a promise that resolves to the temporary file downloaded or rejects
   *         with a JS exception in case of error.
   */
  async downloadAddon(addon, options = { httpsOnlyNoUpgrade: false }) {
    let path = await downloadFile(addon.URL, options);
    try {
      await verifyFile(addon, path);
      return path;
    } catch (e) {
      await OS.File.remove(path);
      throw e;
    }
  },
};
