"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildSearchArguments = buildSearchArguments;
exports.isReadOnlySearchTool = isReadOnlySearchTool;
function buildSearchArguments(inputSchema, query) {
    if (!inputSchema || typeof inputSchema !== 'object')
        return undefined;
    const schema = inputSchema;
    const properties = schema.properties ?? {};
    const queryKeys = [
        'query',
        'search_query',
        'searchQuery',
        'searchTerm',
        'search_term',
        'searchString',
        'text',
        'term',
        'keywords',
        'q',
    ];
    const key = queryKeys.find((candidate) => {
        const property = properties[candidate];
        return property && (!property.type || property.type === 'string' || property.type.includes('string'));
    });
    if (!key)
        return undefined;
    const args = { [key]: query };
    for (const required of schema.required ?? []) {
        if (required in args)
            continue;
        const name = required.toLowerCase();
        if (/^(limit|maxresults|page_size|pagesize|count)$/.test(name))
            args[required] = 5;
        else if (/^(cursor|start|offset)$/.test(name))
            args[required] = 0;
        else
            return undefined;
    }
    for (const [name, property] of Object.entries(properties)) {
        if (name in args || (schema.required ?? []).includes(name))
            continue;
        if (/^(limit|maxresults|page_size|pagesize|count)$/.test(name) && property.type === 'number') {
            args[name] = 5;
        }
    }
    return args;
}
function isReadOnlySearchTool(name, description, service) {
    const normalized = name.toLowerCase().replace(/[-\s]/g, '_');
    const label = `${name.replace(/([a-z0-9])([A-Z])/g, '$1 $2')} ${description}`.toLowerCase();
    if (/\b(create|update|delete|write|edit|comment|transition|move|archive|upload|publish|manage|add|remove|set|merge|approve)\b/.test(label)) {
        return false;
    }
    if (service === 'notion')
        return normalized === 'notion_search';
    if (service === 'atlassian') {
        return ['search', 'searchjiraissuesusingjql', 'searchconfluence', 'searchatlassian'].includes(normalized);
    }
    if (service === 'github')
        return /^search_[a-z_]+$/.test(normalized);
    if (service === 'aha')
        return /^(search|search_[a-z_]+|find_[a-z_]+|query_[a-z_]+)$/.test(normalized);
    return /\b(search|query|find|lookup)\b/.test(label);
}
//# sourceMappingURL=tools.js.map