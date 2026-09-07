import {
  assessmentFindingSchema,
  baselineCompatibilitySchema,
  changedFileSchema,
  changedSymbolSchema,
  coverageAssessmentSchema,
  evidenceLinkSchema,
  prChangeSchema,
  prDiffAnalysisSchema,
  pullRequestSchema,
  verificationResultSchema,
} from "./assessment.ts"
import { runEventSchema } from "./events.ts"
import {
  codeExplorerMissionSchema,
  codeMissionResultSchema,
} from "./code-explorer.ts"
import {
  browserFactEnvelopeSchema,
  browserTransitionSchema,
  codeFactEnvelopeSchema,
  codeSymbolFactSchema,
  documentFactEnvelopeSchema,
  evidenceReferenceSchema,
  requirementCandidateSchema,
} from "./facts.ts"
import {
  applicationSchema,
  discoveryMissionSchema,
  missionResultSchema,
  runSchema,
  sourceSchema,
} from "./operations.ts"
import { parseContract } from "./validation.ts"

export const parseApplication = (input: unknown) =>
  parseContract("application", applicationSchema, input)
export const parseSource = (input: unknown) =>
  parseContract("source", sourceSchema, input)
export const parseRun = (input: unknown) =>
  parseContract("run", runSchema, input)
export const parseDiscoveryMission = (input: unknown) =>
  parseContract("discovery mission", discoveryMissionSchema, input)
export const parseMissionResult = (input: unknown) =>
  parseContract("mission result", missionResultSchema, input)
export const parseCodeExplorerMission = (input: unknown) =>
  parseContract("code explorer mission", codeExplorerMissionSchema, input)
export const parseCodeMissionResult = (input: unknown) =>
  parseContract("code mission result", codeMissionResultSchema, input)
export const parseDocumentFactEnvelope = (input: unknown) =>
  parseContract("document fact envelope", documentFactEnvelopeSchema, input)
export const parseCodeFactEnvelope = (input: unknown) =>
  parseContract("code fact envelope", codeFactEnvelopeSchema, input)
export const parseBrowserFactEnvelope = (input: unknown) =>
  parseContract("browser fact envelope", browserFactEnvelopeSchema, input)
export const parseRequirementCandidate = (input: unknown) =>
  parseContract("requirement candidate", requirementCandidateSchema, input)
export const parseCodeSymbolFact = (input: unknown) =>
  parseContract("code symbol", codeSymbolFactSchema, input)
export const parseEvidenceReference = (input: unknown) =>
  parseContract("evidence reference", evidenceReferenceSchema, input)
export const parseBrowserTransition = (input: unknown) =>
  parseContract("browser transition", browserTransitionSchema, input)
export const parseEvidenceLink = (input: unknown) =>
  parseContract("evidence link", evidenceLinkSchema, input)
export const parseCoverageAssessment = (input: unknown) =>
  parseContract("coverage assessment", coverageAssessmentSchema, input)
export const parsePullRequest = (input: unknown) =>
  parseContract("pull request", pullRequestSchema, input)
export const parsePrChange = (input: unknown) =>
  parseContract("PR change", prChangeSchema, input)
export const parseBaselineCompatibility = (input: unknown) =>
  parseContract("baseline compatibility", baselineCompatibilitySchema, input)
export const parseChangedFile = (input: unknown) =>
  parseContract("changed file", changedFileSchema, input)
export const parseChangedSymbol = (input: unknown) =>
  parseContract("changed symbol", changedSymbolSchema, input)
export const parsePrDiffAnalysis = (input: unknown) =>
  parseContract("PR diff analysis", prDiffAnalysisSchema, input)
export const parseAssessmentFinding = (input: unknown) =>
  parseContract("assessment finding", assessmentFindingSchema, input)
export const parseVerificationResult = (input: unknown) =>
  parseContract("verification result", verificationResultSchema, input)
export const parseRunEvent = (input: unknown) =>
  parseContract("run event", runEventSchema, input)
