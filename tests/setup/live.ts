if (process.env["RUN_LIVE_TESTS"] !== "1") {
  throw new Error("Live tests require RUN_LIVE_TESTS=1")
}
