# Generation Workspace

A local workspace for creating, reviewing, and retaining AI-generated media.

## Language

**Batch**:
A group of generation results presented together for review; each result is kept or discarded independently.
_Avoid_: Job, run, collection

**Temporary result**:
A generated result that has not been kept and is removed when the local application exits.
_Avoid_: Draft, cached result

**Kept result**:
A generated result manually selected for durable storage on disk.
_Avoid_: Approved result, saved result

**Prompt template**:
A named prompt body saved for reuse within one media type, without variable substitution.
_Avoid_: Preset, macro

**Conversation**:
A sequence of user and assistant messages reviewed as one Text result; the whole conversation is either kept or discarded.
_Avoid_: Text batch, thread
