function asyncHandler(fn) {
  return function wrappedAsyncHandler(req, res, next) {
    return Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
