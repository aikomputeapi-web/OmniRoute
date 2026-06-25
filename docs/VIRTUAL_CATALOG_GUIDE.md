# Virtual Catalog Guide

## Overview

The **Virtual Catalog** is a system that consolidates models from multiple providers into clean, unified model names. Instead of users seeing `nvidia/glm-5.1`, `openai-grok/glm-5.1`, and `kimi/glm-5.1` as separate models, they see a single `glm-5.1` entry that automatically routes to the best available provider.

## How It Works

### Architecture

The virtual catalog operates through two main files:

1. **`OmniRoute/src/lib/catalog/generateVirtualCatalog.ts`** - Backend catalog generation logic
2. **`OmniRoute/src/app/api/v1/models/catalog.ts`** - API endpoint that serves the catalog to clients

Both files must be kept in sync with identical logic.

### Core Components

#### 1. `FORCED_CONSOLIDATION_MODELS` Set

This set defines which models should be consolidated across providers:

```typescript
const FORCED_CONSOLIDATION_MODELS = new Set([
  "claude-sonnet-4-6",
  "glm-5.1",
  "kimi-2.6",
  "deepseek-v4",
  "mistral-large",
  // ... etc
]);
```

**Purpose**: Only models in this set will be consolidated. All other models remain provider-specific.

#### 2. `getCanonicalRootId()` Function

This function maps various model name variants to their canonical form:

```typescript
export function getCanonicalRootId(rootId: string): string {
  const lower = rootId.toLowerCase();
  
  // Maps "glm", "glm-5", "glm-5.1" all to "glm-5.1"
  if (lower.includes("glm")) return "glm-5.1";
  
  // Maps "kimi", "kimi-k2", "kimi-k2.6" all to "kimi-2.6"
  if (lower.includes("kimi")) return "kimi-2.6";
  
  return rootId;
}
```

**Purpose**: Ensures that different naming conventions (e.g., `kimi-k2.6` from one provider, `kimi-k2` from another) map to the same canonical name.

#### 3. `ALLOWED_NVIDIA_MODELS` Set (Optional)

Whitelists specific NVIDIA NIM models for consolidation:

```typescript
const ALLOWED_NVIDIA_MODELS = new Set([
  "z-ai/glm-5.1",
  "minimaxai/minimax-m2.7",
  "google/gemma-4-31b-it",
  // ... etc
]);
```

**Purpose**: Prevents unwanted NVIDIA models from being auto-consolidated.

## Common Operations

### Adding a New Model to Virtual Catalog

**Example**: Adding a new model `nemotron-3-super` from NVIDIA NIM.

#### Step 1: Add to `ALLOWED_NVIDIA_MODELS` (if from NVIDIA)

```typescript
const ALLOWED_NVIDIA_MODELS = new Set([
  // ... existing entries
  "nvidia/nemotron-3-super-120b-a12b",  // Add full NVIDIA model ID
]);
```

#### Step 2: Add to `FORCED_CONSOLIDATION_MODELS`

Add to **both** `generateVirtualCatalog.ts` and `catalog.ts`:

```typescript
const FORCED_CONSOLIDATION_MODELS = new Set([
  // ... existing entries
  "nemotron-3-super",  // Add canonical name
]);
```

#### Step 3: Add Canonical Mapping

Add logic to `getCanonicalRootId()` in **both** files:

```typescript
export function getCanonicalRootId(rootId: string): string {
  const lower = rootId.toLowerCase();
  
  // ... existing mappings
  
  // New mapping
  if (lower.includes("nemotron") && lower.includes("3") && lower.includes("super")) {
    return "nemotron-3-super";
  }
  
  return rootId;
}
```

**Result**: Users now see `nemotron-3-super` instead of provider-specific names.

### Removing a Model from Virtual Catalog

**Example**: Removing Gemini 2.5 models from user access.

#### Step 1: Remove from `FORCED_CONSOLIDATION_MODELS`

Remove from **both** `generateVirtualCatalog.ts` and `catalog.ts`:

```typescript
const FORCED_CONSOLIDATION_MODELS = new Set([
  // Remove these lines:
  // "gemini-2-5-pro",
  // "gemini-2-5-flash",
]);
```

**Result**: Models are no longer consolidated. Users see provider-specific names (e.g., `gemini/gemini-2.5-pro`) but they're not in the main catalog.

**Note**: You typically DON'T remove the canonical mapping in `getCanonicalRootId()` unless you want to completely prevent consolidation. Removing from `FORCED_CONSOLIDATION_MODELS` is sufficient to hide from users.

### Renaming a Virtual Model

**Example**: Changing `kimi-k2` to `kimi-2.6`.

#### Step 1: Update `FORCED_CONSOLIDATION_MODELS`

In **both** files, replace the old name:

```typescript
const FORCED_CONSOLIDATION_MODELS = new Set([
  // "kimi-k2",  // Old
  "kimi-2.6",    // New
]);
```

#### Step 2: Update `getCanonicalRootId()`

Update the return value in **both** files:

```typescript
// Before:
if (lower.includes("kimi")) return "kimi-k2";

// After:
if (lower.includes("kimi")) return "kimi-2.6";
```

#### Step 3: Add Backward Compatibility (Optional)

Add old name to extra patterns for routing:

```typescript
if (rootId === "kimi-2.6") {
  const extraPatterns = [
    "kimi-2.6",
    "kimi-k2",      // Old name for backward compat
    "kimi-k2.6",
    // ... other variants
  ];
}
```

**Result**: Model now appears as `kimi-2.6`, but requests to `kimi-k2` still work.

### Combining Multiple Provider Models

**Example**: Consolidating DeepSeek v4 from multiple providers.

Models across providers that map to the same canonical name are automatically combined:

- `deepseek-ai/deepseek-v4-pro` (NVIDIA)
- `deepseek/deepseek-v4` (DeepSeek direct)
- `openrouter/deepseek-v4` (OpenRouter)

All map to `deepseek-v4` because `getCanonicalRootId()` returns `"deepseek-v4"` for all of them.

#### Implementation:

```typescript
// In getCanonicalRootId():
if (lower.includes("deepseek") && (lower.includes("v4") || lower.includes("v-4"))) {
  return "deepseek-v4";
}

// In FORCED_CONSOLIDATION_MODELS:
const FORCED_CONSOLIDATION_MODELS = new Set([
  "deepseek-v4",  // This consolidates ALL v4 variants
]);
```

**Result**: Single `deepseek-v4` entry that automatically load-balances across all providers.

## Best Practices

### 1. Always Update Both Files

Changes must be made to **both**:
- `OmniRoute/src/lib/catalog/generateVirtualCatalog.ts`
- `OmniRoute/src/app/api/v1/models/catalog.ts`

Inconsistencies between these files cause bugs.

### 2. Use Descriptive Canonical Names

- ✅ Good: `glm-5.1`, `kimi-2.6`, `mistral-large`
- ❌ Bad: `glm`, `kimi`, `mistral` (too generic, version unclear)

### 3. Order Matters in `getCanonicalRootId()`

Place more specific checks before generic ones:

```typescript
// ✅ Correct order:
if (lower.includes("deepseek") && lower.includes("r1")) return "deepseek-r1";
if (lower.includes("deepseek") && lower.includes("v4")) return "deepseek-v4";
if (lower.includes("deepseek")) return "deepseek-v3";  // Catch-all last

// ❌ Wrong order (catch-all first):
if (lower.includes("deepseek")) return "deepseek-v3";  // This catches everything!
if (lower.includes("deepseek") && lower.includes("v4")) return "deepseek-v4";  // Never reached
```

### 4. Provider-Specific Whitelists

Use provider-specific sets (like `ALLOWED_NVIDIA_MODELS`) to control which models consolidate:

```typescript
// Only these NVIDIA models participate in consolidation
const ALLOWED_NVIDIA_MODELS = new Set([
  "z-ai/glm-5.1",
  "google/gemma-4-31b-it",
]);
```

This prevents every NVIDIA model from auto-consolidating.

### 5. Test Consolidation

After changes, verify:
1. Model appears with correct name in `/v1/models`
2. Requests to the virtual name route correctly
3. Old names still work (if backward compat added)
4. Multiple providers properly combine

## Troubleshooting

### Model Not Consolidating

**Symptoms**: Model appears as `provider/model` instead of clean name.

**Checklist**:
- [ ] Is the canonical name in `FORCED_CONSOLIDATION_MODELS`?
- [ ] Does `getCanonicalRootId()` map to that name?
- [ ] If from NVIDIA, is it in `ALLOWED_NVIDIA_MODELS`?
- [ ] Are both files (`generateVirtualCatalog.ts` and `catalog.ts`) updated?

### Wrong Models Consolidating Together

**Symptoms**: Unrelated models grouped under one name.

**Issue**: `getCanonicalRootId()` logic is too broad.

**Fix**: Make the matching more specific:

```typescript
// Too broad - catches everything with "gemini":
if (lower.includes("gemini")) return "gemini-3-1-pro";

// Better - specific version check:
if (lower.includes("gemini") && lower.includes("pro") && lower.includes("3.1")) {
  return "gemini-3-1-pro";
}
```

### Model Still Appears After Removal

**Issue**: Removed from `FORCED_CONSOLIDATION_MODELS` but still shows.

**Cause**: Individual provider models bypass consolidation. The model isn't "removed," it just loses its consolidated entry.

**Solution**: To completely hide, also add to `BLOCKLISTED_ROOT_IDS`:

```typescript
const BLOCKLISTED_ROOT_IDS = new Set([
  "gemini-2-5-pro",  // Blocks from all catalogs
]);
```

## File Structure Reference

```
OmniRoute/
├── src/
│   ├── lib/
│   │   └── catalog/
│   │       └── generateVirtualCatalog.ts    ← Backend logic (PRIMARY)
│   └── app/
│       └── api/
│           └── v1/
│               └── models/
│                   └── catalog.ts            ← API endpoint (MUST MATCH PRIMARY)
└── docs/
    ├── VIRTUAL_CATALOG.md                    ← High-level docs
    └── VIRTUAL_CATALOG_GUIDE.md              ← This guide
```

## Quick Reference

### Adding a Model
1. Add to `ALLOWED_NVIDIA_MODELS` (if applicable)
2. Add to `FORCED_CONSOLIDATION_MODELS` in both files
3. Add mapping in `getCanonicalRootId()` in both files

### Removing a Model
1. Remove from `FORCED_CONSOLIDATION_MODELS` in both files
2. Optionally remove from `getCanonicalRootId()` (not usually needed)

### Renaming a Model
1. Update name in `FORCED_CONSOLIDATION_MODELS` in both files
2. Update return value in `getCanonicalRootId()` in both files
3. Add old name to extra patterns for backward compat

### Combining Providers
1. Ensure all provider variants map to same canonical name via `getCanonicalRootId()`
2. Add canonical name to `FORCED_CONSOLIDATION_MODELS`
3. System automatically combines matching models

## Examples from Recent Changes

### Example 1: Added NVIDIA NIM Models (2026-06-24)

```typescript
// Step 1: Whitelist in ALLOWED_NVIDIA_MODELS
const ALLOWED_NVIDIA_MODELS = new Set([
  "google/gemma-4-31b-it",
  "mistralai/mistral-large-3-675b-instruct-2512",
  "nvidia/nemotron-3-super-120b-a12b",
]);

// Step 2: Add to forced consolidation
const FORCED_CONSOLIDATION_MODELS = new Set([
  "gemma-4-31b",
  "mistral-large",
  "nemotron-3-super",
]);

// Step 3: Add canonical mappings
export function getCanonicalRootId(rootId: string): string {
  const lower = rootId.toLowerCase();
  
  if (lower.includes("gemma") && lower.includes("4") && lower.includes("31b")) {
    return "gemma-4-31b";
  }
  if (lower.includes("mistral") && lower.includes("large")) {
    return "mistral-large";
  }
  if (lower.includes("nemotron") && lower.includes("3") && lower.includes("super")) {
    return "nemotron-3-super";
  }
  
  return rootId;
}
```

### Example 2: Renamed Kimi K2 to Kimi 2.6 (2026-06-24)

```typescript
// Updated FORCED_CONSOLIDATION_MODELS
const FORCED_CONSOLIDATION_MODELS = new Set([
  "kimi-2.6",  // Changed from "kimi-k2"
]);

// Updated canonical mapping
export function getCanonicalRootId(rootId: string): string {
  if (lower.includes("kimi")) return "kimi-2.6";  // Changed from "kimi-k2"
}

// Added backward compat patterns
if (rootId === "kimi-2.6") {
  const extraPatterns = [
    "kimi-2.6",
    "kimi-k2",      // Old name still works
    "kimi-k2.6",
  ];
}
```

### Example 3: Removed Gemini 2.5 from Catalog (2026-06-24)

```typescript
// Removed from FORCED_CONSOLIDATION_MODELS (both files)
const FORCED_CONSOLIDATION_MODELS = new Set([
  // "gemini-2-5-pro",    ← Removed
  // "gemini-2-5-flash",  ← Removed
  "gemini-3-1-pro",      // Other Gemini models kept
  "gemini-3-flash",
]);

// Note: Did NOT remove from getCanonicalRootId()
// The mapping still exists but without forced consolidation,
// these models simply don't appear in the virtual catalog
```

---

**Last Updated**: 2026-06-24  
**Maintained By**: AI Agents managing OmniRoute virtual catalog
