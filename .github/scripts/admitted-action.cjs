"use strict";

// One awaited operation, matching the source QA admission contract. A precheck
// is not resource ownership: only the external owner holds its resource guard.
module.exports = async (precheck, action) => {
  if (typeof precheck !== "function" || typeof action !== "function") {
    throw new TypeError("admission_callbacks_required");
  }
  const check = await precheck();
  if (check === null || typeof check !== "object" || check.exit_code !== 0 ||
      check.isError === true || check.session_id != null) {
    throw new Error("admission_precheck_not_passed");
  }
  return await action();
};
