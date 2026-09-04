export const LEASH_FEATURE_PRESENTATIONS = {
    "blast-radius": {
        "id": "openleash.blast-radius",
        "slug": "blast-radius",
        "name": "Destructive Protection",
        "description": "Stops AI before it recursively deletes folders, wipes databases, or makes other broad destructive changes.",
        "category": "protection",
        "iconText": "💥",
        "showcaseOrder": 1
    },
    "code-scanner": {
        "id": "openleash.code-scanner",
        "slug": "code-scanner",
        "name": "Code Protection",
        "description": "Checks the code AI writes and warns you when it could make your app unsafe.",
        "category": "protection",
        "iconText": "☣️",
        "showcaseOrder": 2
    },
    "data-leakage-prevention": {
        "id": "openleash.dlp",
        "slug": "data-leakage-prevention",
        "name": "Private Data Protection",
        "description": "Stops AI from accidentally sharing passwords, personal information, or private files.",
        "category": "protection",
        "iconText": "🤫",
        "showcaseOrder": 3
    },
    "sensitive-access": {
        "id": "openleash.sensitive-access",
        "slug": "sensitive-access",
        "name": "Secret Protection",
        "description": "Asks before AI opens password files, sign-in details, or other private access information.",
        "category": "protection",
        "iconText": "🔐",
        "showcaseOrder": 4
    },
    "skill-scanner": {
        "id": "openleash.skill-scanner",
        "slug": "skill-scanner",
        "name": "Prompt Injection Protection",
        "description": "Finds hidden instructions that try to make AI do something you did not ask it to do.",
        "category": "protection",
        "iconText": "🕵️",
        "showcaseOrder": 5
    },
    "mcp-scanner": {
        "id": "openleash.mcp-scanner",
        "slug": "mcp-scanner",
        "name": "Tool Protection",
        "description": "Shows which outside apps and tools AI can use and warns you when something changes.",
        "category": "protection",
        "iconText": "📡",
        "showcaseOrder": 6
    },
    "rules-enforcer": {
        "id": "openleash.rules-enforcer",
        "slug": "rules-enforcer",
        "name": "Rules Protection",
        "description": "Makes AI follow the project rules you choose and asks before it crosses one.",
        "category": "protection",
        "iconText": "📏",
        "showcaseOrder": 7
    },
    "token-saver": {
        "id": "openleash.prompt-compression",
        "slug": "token-saver",
        "name": "Token Saver",
        "description": "Cuts repeated text so your AI bill is lower without removing the important parts.",
        "category": "cost",
        "iconText": "✂️",
        "showcaseOrder": 8
    },
};
const featureAliases = {
    "openleash.blast-radius": "blast-radius",
    "openleash.code-scanner": "code-scanner",
    "openleash.dlp": "data-leakage-prevention",
    "dlp": "data-leakage-prevention",
    "openleash.sensitive-access": "sensitive-access",
    "openleash.skill-scanner": "skill-scanner",
    "openleash.mcp-scanner": "mcp-scanner",
    "openleash.rules-enforcer": "rules-enforcer",
    "openleash.prompt-compression": "token-saver",
    "prompt-compression": "token-saver"
};
export function leashFeaturePresentation(value) {
    const normalized = String(value ?? "").trim().toLowerCase();
    const slug = featureAliases[normalized] ?? normalized;
    return LEASH_FEATURE_PRESENTATIONS[slug];
}
export const LEASH_FEATURE_SHOWCASE = Object.values(LEASH_FEATURE_PRESENTATIONS)
    .sort((left, right) => left.showcaseOrder - right.showcaseOrder);
