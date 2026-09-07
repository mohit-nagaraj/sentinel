import { Node } from "ts-morph"

import type { IndexWarning, UnresolvedReason } from "./errors.ts"
import { compareBy, compareNumbers, compareStrings } from "./identity.ts"
import type { TypeScriptIndexLimits } from "./limits.ts"
import type { LoadedSourceFile } from "./project.ts"
import {
  boundTargetText,
  enclosingSymbol,
  rangeOf,
  resolveToIndexedSymbol,
} from "./references.ts"
import type { SourceRange } from "./slices.ts"
import type { SymbolRecord } from "./symbols.ts"

/**
 * Attributes that carry a human-visible or test-visible identity. These are the
 * only attribute values recorded, so styling and layout props never enter the
 * evidence graph.
 */
export const accessibleHintAttributes = Object.freeze([
  "alt",
  "aria-label",
  "aria-labelledby",
  "data-testid",
  "href",
  "id",
  "label",
  "name",
  "placeholder",
  "role",
  "title",
  "type",
  "value",
] as const)

const MAX_HINT_LENGTH = 512
const MAX_TEXT_LENGTH = 512

/** Tagged-template helpers whose value is a static string when unsubstituted. */
const staticTemplateTags = new Set(["t", "msg", "defineMessage"])

export interface JsxHint {
  readonly attribute: string
  readonly value: string
}

export interface JsxElementRecord {
  readonly filePath: string
  /** Enclosing component, or the module symbol for a top-level element. */
  readonly ownerQualifiedName: string
  readonly tagName: string
  readonly range: SourceRange
  readonly hints: readonly JsxHint[]
  /** Static child text, when the element has any. */
  readonly text: string | undefined
  readonly unresolvedReasons: readonly UnresolvedReason[]
}

export interface HandlerBindingRecord {
  readonly filePath: string
  readonly ownerQualifiedName: string
  readonly tagName: string
  /** Event attribute name, e.g. `onSubmit`. */
  readonly event: string
  readonly handlerQualifiedName: string | undefined
  /** The handler is an inline function rather than a named declaration. */
  readonly inline: boolean
  readonly unresolvedTarget: string | undefined
  readonly unresolvedReason: UnresolvedReason | undefined
  readonly range: SourceRange
}

export interface JsxExtraction {
  readonly elements: readonly JsxElementRecord[]
  readonly handlers: readonly HandlerBindingRecord[]
  readonly warnings: readonly IndexWarning[]
}

/**
 * Reads a statically knowable string from a JSX attribute value or child.
 *
 * A template literal counts as static only when it has no substitutions, and a
 * tagged template only for the known i18n macros — `t\`Log in\`` is a fixed
 * label, while `t\`Hello ${name}\`` is not and must stay unresolved.
 */
export function readStaticText(node: Node | undefined): string | undefined {
  if (node === undefined) return undefined
  if (Node.isStringLiteral(node)) return node.getLiteralValue()
  if (Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralValue()
  if (Node.isJsxText(node)) {
    const text = node.getText().replace(/\s+/g, " ").trim()
    return text.length > 0 ? text : undefined
  }
  if (Node.isJsxExpression(node)) return readStaticText(node.getExpression())
  if (Node.isTaggedTemplateExpression(node)) {
    const tag = node.getTag().getText()
    if (!staticTemplateTags.has(tag)) return undefined
    return readStaticText(node.getTemplate())
  }
  if (Node.isTemplateExpression(node)) return undefined
  if (Node.isNumericLiteral(node)) return node.getText()
  return undefined
}

function containsFunction(node: Node): boolean {
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) return true
  return node
    .getDescendants()
    .some(
      (descendant) =>
        Node.isArrowFunction(descendant) ||
        Node.isFunctionExpression(descendant)
    )
}

function resolveHandler(
  expression: Node,
  byDeclaration: ReadonlyMap<Node, SymbolRecord>
): Pick<
  HandlerBindingRecord,
  "handlerQualifiedName" | "inline" | "unresolvedReason" | "unresolvedTarget"
> {
  const nameNode = Node.isIdentifier(expression)
    ? expression
    : Node.isPropertyAccessExpression(expression)
      ? expression.getNameNode()
      : undefined
  if (nameNode !== undefined) {
    const target = resolveToIndexedSymbol(nameNode.getSymbol(), byDeclaration)
    if (target !== undefined) {
      return {
        handlerQualifiedName: target.qualifiedName,
        inline: false,
        unresolvedReason: undefined,
        unresolvedTarget: undefined,
      }
    }
    return {
      handlerQualifiedName: undefined,
      inline: false,
      unresolvedReason: "computed_handler",
      unresolvedTarget: boundTargetText(expression),
    }
  }
  if (containsFunction(expression)) {
    return {
      handlerQualifiedName: undefined,
      inline: true,
      unresolvedReason: undefined,
      unresolvedTarget: undefined,
    }
  }
  return {
    handlerQualifiedName: undefined,
    inline: false,
    unresolvedReason: "computed_handler",
    unresolvedTarget: boundTargetText(expression),
  }
}

export function extractJsx(
  file: LoadedSourceFile,
  fileSymbols: readonly SymbolRecord[],
  byDeclaration: ReadonlyMap<Node, SymbolRecord>,
  limits: TypeScriptIndexLimits
): JsxExtraction {
  const moduleSymbol = fileSymbols.find(
    (symbol) => symbol.qualifiedName === file.path
  )
  if (moduleSymbol === undefined) {
    return {
      elements: Object.freeze([]),
      handlers: Object.freeze([]),
      warnings: Object.freeze([]),
    }
  }

  const elements: JsxElementRecord[] = []
  const handlers: HandlerBindingRecord[] = []
  const warnings: IndexWarning[] = []
  let budgetReported = false

  file.sourceFile.forEachDescendant((node) => {
    if (!Node.isJsxElement(node) && !Node.isJsxSelfClosingElement(node)) return
    if (elements.length >= limits.maxJsxElementsPerFile) {
      if (!budgetReported) {
        budgetReported = true
        warnings.push({
          reason: "jsx_budget_exhausted",
          path: file.path,
          detail: `more than ${limits.maxJsxElementsPerFile} JSX elements`,
        })
      }
      return
    }

    const opening = Node.isJsxElement(node) ? node.getOpeningElement() : node
    const tagName = opening.getTagNameNode().getText()
    const owner = enclosingSymbol(node, byDeclaration, moduleSymbol)
    const hints: JsxHint[] = []
    const reasons = new Set<UnresolvedReason>()

    for (const attribute of opening.getAttributes()) {
      if (!Node.isJsxAttribute(attribute)) continue
      const name = attribute.getNameNode().getText()
      const initializer = attribute.getInitializer()

      if (/^on[A-Z]/.test(name)) {
        const expression = Node.isJsxExpression(initializer)
          ? initializer.getExpression()
          : initializer
        if (expression === undefined) {
          handlers.push({
            filePath: file.path,
            ownerQualifiedName: owner.qualifiedName,
            tagName,
            event: name,
            handlerQualifiedName: undefined,
            inline: false,
            unresolvedTarget: undefined,
            unresolvedReason: "computed_handler",
            range: rangeOf(attribute),
          })
          continue
        }
        handlers.push({
          filePath: file.path,
          ownerQualifiedName: owner.qualifiedName,
          tagName,
          event: name,
          ...resolveHandler(expression, byDeclaration),
          range: rangeOf(attribute),
        })
        continue
      }

      if (!accessibleHintAttributes.includes(name as never)) continue
      if (initializer === undefined) {
        // A valueless boolean attribute such as `disabled` carries no name.
        continue
      }
      const value = readStaticText(initializer)
      if (value === undefined) {
        reasons.add("dynamic_accessible_name")
        continue
      }
      hints.push({ attribute: name, value: value.slice(0, MAX_HINT_LENGTH) })
    }

    const childTexts = Node.isJsxElement(node)
      ? node
          .getJsxChildren()
          .map((child) => readStaticText(child))
          .filter((value): value is string => value !== undefined)
      : []
    const text = childTexts.join(" ").trim().slice(0, MAX_TEXT_LENGTH)

    elements.push({
      filePath: file.path,
      ownerQualifiedName: owner.qualifiedName,
      tagName,
      range: rangeOf(node),
      hints: Object.freeze(
        hints.sort((left, right) =>
          compareStrings(left.attribute, right.attribute)
        )
      ),
      text: text.length > 0 ? text : undefined,
      unresolvedReasons: Object.freeze([...reasons].sort(compareStrings)),
    })
  })

  return {
    elements: Object.freeze(
      elements.sort((left, right) =>
        compareBy(
          compareNumbers(left.range.startLine, right.range.startLine),
          compareStrings(left.tagName, right.tagName)
        )
      )
    ),
    handlers: Object.freeze(
      handlers.sort((left, right) =>
        compareBy(
          compareNumbers(left.range.startLine, right.range.startLine),
          compareStrings(left.event, right.event)
        )
      )
    ),
    warnings: Object.freeze(warnings),
  }
}
