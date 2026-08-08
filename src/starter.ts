// The comments-only starter declares no governed paths. It is deliberately a
// useful reference rather than an opinionated vault layout.
export const starterConfig = `# Autofile governs only the paths you declare. strict: true also governs files
# outside every declared path.
# strict: false
# paths:
#   /contacts:
#     description: What belongs here and how to file it.
#     schema:
#       type: object
#     body:
#       allowed: true
#     extensions: [md]
#     filenames:
#       pattern: '^[a-z0-9-]+$'
#     internal_links:
#       resolve: true
#       format: wikilink
#     ignore:
#       dotfiles: true
#       pattern: '^_'
`;
