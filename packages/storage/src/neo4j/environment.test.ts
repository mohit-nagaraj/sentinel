import { describe, expect, it } from "vitest"

import {
  loadNeo4jEnvironment,
  loadNeo4jIntegrationEnvironment,
  Neo4jConfigurationError,
} from "./environment.ts"

const validEnvironment = {
  NEO4J_URI: "neo4j+s://example.databases.neo4j.io",
  NEO4J_USERNAME: "neo4j",
  NEO4J_PASSWORD: "never-print-this-password",
  NEO4J_DATABASE: "neo4j",
}

describe("Neo4j environment", () => {
  it("accepts an encrypted Aura URI and explicit database", () => {
    expect(loadNeo4jEnvironment(validEnvironment)).toEqual(validEnvironment)
  })

  it("reports invalid fields without leaking credentials", () => {
    let captured: unknown
    try {
      loadNeo4jEnvironment({
        ...validEnvironment,
        NEO4J_PASSWORD: "",
      })
    } catch (error) {
      captured = error
    }

    expect(captured).toBeInstanceOf(Neo4jConfigurationError)
    expect(String(captured)).toContain("NEO4J_PASSWORD")
    expect(String(captured)).not.toContain(validEnvironment.NEO4J_PASSWORD)
  })

  it("rejects URI paths and unsafe integration prefixes", () => {
    expect(() =>
      loadNeo4jEnvironment({
        ...validEnvironment,
        NEO4J_URI: "neo4j+s://example.databases.neo4j.io/path",
      })
    ).toThrow(Neo4jConfigurationError)
    expect(() =>
      loadNeo4jIntegrationEnvironment({
        RUN_NEO4J_INTEGRATION_TESTS: "1",
        SENTINEL_NEO4J_TEST_PREFIX: "production",
      })
    ).toThrow(Neo4jConfigurationError)
  })

  it("requires an explicit opt-in and generated namespace", () => {
    expect(
      loadNeo4jIntegrationEnvironment({
        RUN_NEO4J_INTEGRATION_TESTS: "1",
        SENTINEL_NEO4J_TEST_PREFIX: "sentinel-test-a1b2c3d4",
      })
    ).toEqual({
      RUN_NEO4J_INTEGRATION_TESTS: "1",
      SENTINEL_NEO4J_TEST_PREFIX: "sentinel-test-a1b2c3d4",
    })
  })
})
