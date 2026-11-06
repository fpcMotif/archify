# Archify

Archify turns an authored diagram description into a checked, standalone HTML diagram. These terms name what authors, agents and the checks exchange while a diagram is repaired.

## Language

**Candidate**:
The authored diagram JSON that is checked before delivery and that repairs change.
_Avoid_: input, source, spec

**Artifact**:
The standalone HTML file rendered from a candidate and delivered to the reader.
_Avoid_: output, page, render

**Artifact check**:
The static check of an artifact's bytes that returns a receipt with a pass or fail verdict.
_Avoid_: checker run, render check, validation

**Browser check**:
The check that opens an artifact in a real browser and measures what it shows.
_Avoid_: visual check, screenshot check

**Diagnostic**:
A coded finding about a candidate or its rendered output, with a subject, measured evidence and fixes.
_Avoid_: error, issue, warning (severity is a field of a diagnostic, not a separate kind)

**Fix**:
A repair hint on a diagnostic. It is an edit, a choice between repairs, or advice.
_Avoid_: suggestion, hint, supported fix

**Edit**:
A fix that sets one location in the candidate to one exact value.
_Avoid_: patch, change, set fix

**Repair**:
The edits on one diagnostic, which hold only when all of them are applied together.
_Avoid_: fix set, edit list

**Choice**:
A fix that offers several repairs, of which exactly one should be applied.
_Avoid_: alternatives, candidates (a candidate is the diagram JSON)

**Advice**:
A fix stated only in words, because it needs a judgment no exact value can carry.
_Avoid_: manual fix, note
