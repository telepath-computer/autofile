// The spec/cli.md starter config, verbatim — what `autofile init` writes.
export const starterConfig = String.raw`global:
  ignore:
    pattern: '^\.'
  filenames:
    pattern: '^[a-z0-9][a-z0-9-]*$'
  assets:
    allowed: false

paths:
  datasets:
    description: |
      Standalone structured data — items that are not part of a larger
      collection: one file per dataset.
    records:
      schema:
        required: [title, description, data]
        properties:
          title:
            type: string
            description: Human-readable name of the dataset.
          description:
            type: string
            description: One-line summary of what this holds and is for.
          data:
            description: The payload — any JSON value.
          schema:
            type: object
            description: JSON Schema for the payload; when present, verify
              data against it when editing.

  assets:
    description: |
      Source material and attached files: scans, photos, downloads.
    assets:
      allowed: true

  topics:
    description: |
      Durable notes on anything worth remembering: one file per topic,
      holding what an agent should know when working on it. Update the
      existing note as the topic develops.
    records:
      schema:
        required: [title, description]
        properties:
          title:
            type: string
            description: Human-readable name of the topic.
          description:
            type: string
            description: One-line summary, written for retrieval.
`;
