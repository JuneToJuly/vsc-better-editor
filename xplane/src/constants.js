const ENTRY_TYPES = [
    "Documentation",
    "Comment",
    "Question",
    "Decision",
    "Requirement",
    "TODO",
    "Warning",
    "Design",
    "Example",
    "Test"
];

const STORAGE_DIRECTORY = ".x-plane";
const STORAGE_FILE = "entries.json";
const LEGACY_STORAGE_DIRECTORY = ".code-knowledge";
const LEGACY_STORAGE_FILE = "knowledge.json";
const STORAGE_VERSION = 4;

module.exports = {
    ENTRY_TYPES,
    STORAGE_DIRECTORY,
    STORAGE_FILE,
    LEGACY_STORAGE_DIRECTORY,
    LEGACY_STORAGE_FILE,
    STORAGE_VERSION
};
