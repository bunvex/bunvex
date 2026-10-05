// The schemas of the deployment's OpenAPI documents (openapi.ts, STUDY-115): Convex's request and response
// shapes for the routes bunvex has (the structure of the documents Convex generates with utoipa, as checked in
// at npm-packages/@convex-dev/platform/*-openapi.json and npm-packages/dashboard/), with bunvex's wire names
// (`bunvexCloud`: DV-278; `actionComputeIsolateGbHours`: DV-308) and bunvex's own descriptions.

/** A JSON Schema object, as OpenAPI 3.1 embeds it. */
export type JsonSchema = { [key: string]: unknown };

/** `/api/v1/openapi.json`: the platform API's schemas. */
export const PLATFORM_SCHEMAS: Record<string, JsonSchema> = {
  AccessTokenId: {
    type: "integer",
    format: "int64",
    minimum: 0,
  },
  ActiveDataSync: {
    type: "object",
    description: "Where an active data sync stands, as of the last page it fetched.",
    required: ["syncId", "lastUpdated", "status"],
    properties: {
      syncId: {
        $ref: "#/components/schemas/SyncId",
      },
      lastUpdated: {
        type: "integer",
        format: "int64",
        description: "When the sync last fetched a page, in milliseconds since the epoch.",
      },
      status: {
        $ref: "#/components/schemas/ActiveDataSyncStatus",
      },
    },
  },
  ActiveDataSyncSnapshotting: {
    type: "object",
    required: [
      "type",
      "numTablesSynced",
      "totalTables",
      "currentComponent",
      "currentTable",
      "numDocumentsInCurrentTable",
      "totalDocumentsInCurrentTable",
      "numDocumentsSynced",
      "totalDocuments",
    ],
    properties: {
      type: {
        oneOf: [
          {
            type: "string",
            enum: ["snapshotting"],
          },
        ],
      },
      numTablesSynced: {
        type: "integer",
        format: "int64",
        minimum: 0,
      },
      totalTables: {
        type: "integer",
        format: "int64",
        minimum: 0,
      },
      currentComponent: {
        type: "string",
      },
      currentTable: {
        type: "string",
      },
      numDocumentsInCurrentTable: {
        type: "integer",
        format: "int64",
        minimum: 0,
      },
      totalDocumentsInCurrentTable: {
        type: "integer",
        format: "int64",
        minimum: 0,
      },
      numDocumentsSynced: {
        type: "integer",
        format: "int64",
        minimum: 0,
      },
      totalDocuments: {
        type: "integer",
        format: "int64",
        minimum: 0,
      },
    },
  },
  ActiveDataSyncStale: {
    type: "object",
    required: ["type", "totalTables", "numDocumentsSynced", "syncedTs"],
    properties: {
      type: {
        oneOf: [
          {
            type: "string",
            enum: ["stale"],
          },
        ],
      },
      totalTables: {
        type: "integer",
        format: "int64",
        minimum: 0,
      },
      numDocumentsSynced: {
        type: "integer",
        format: "int64",
        minimum: 0,
      },
      syncedTs: {
        type: "integer",
        format: "int64",
      },
    },
  },
  ActiveDataSyncStatus: {
    oneOf: [
      {
        $ref: "#/components/schemas/ActiveDataSyncSnapshotting",
      },
      {
        $ref: "#/components/schemas/ActiveDataSyncStale",
      },
      {
        $ref: "#/components/schemas/ActiveDataSyncUpToDate",
      },
    ],
    discriminator: {
      propertyName: "type",
      mapping: {
        snapshotting: "#/components/schemas/ActiveDataSyncSnapshotting",
        stale: "#/components/schemas/ActiveDataSyncStale",
        upToDate: "#/components/schemas/ActiveDataSyncUpToDate",
      },
    },
  },
  ActiveDataSyncUpToDate: {
    type: "object",
    required: ["type", "totalTables", "numDocumentsSynced", "syncedTs"],
    properties: {
      type: {
        oneOf: [
          {
            type: "string",
            enum: ["upToDate"],
          },
        ],
      },
      totalTables: {
        type: "integer",
        format: "int64",
        minimum: 0,
      },
      numDocumentsSynced: {
        type: "integer",
        format: "int64",
        minimum: 0,
      },
      syncedTs: {
        type: "integer",
        format: "int64",
      },
    },
  },
  AuditLogActor: {
    description: "Who made a change: the deployment itself, or the member an admin key belongs to.",
    oneOf: [
      {
        type: "object",
        title: "System",
        required: ["kind"],
        properties: {
          kind: {
            type: "string",
            enum: ["system"],
          },
        },
      },
      {
        type: "object",
        title: "Member",
        required: ["member_id", "kind"],
        properties: {
          member_id: {
            $ref: "#/components/schemas/MemberId",
          },
          kind: {
            type: "string",
            enum: ["member"],
          },
        },
      },
      {
        type: "object",
        title: "Token",
        required: ["token_id", "kind"],
        properties: {
          member_id: {
            oneOf: [
              {
                type: "null",
              },
              {
                $ref: "#/components/schemas/MemberId",
              },
            ],
          },
          token_id: {
            $ref: "#/components/schemas/AccessTokenId",
          },
          client_id: {
            type: ["string", "null"],
          },
          kind: {
            type: "string",
            enum: ["token"],
          },
        },
      },
    ],
  },
  AxiomAttribute: {
    type: "object",
    required: ["key", "value"],
    properties: {
      key: {
        type: "string",
      },
      value: {
        type: "string",
      },
    },
  },
  AxiomLogStreamConfig: {
    type: "object",
    title: "AxiomConfig",
    required: ["id", "status", "datasetName", "attributes"],
    properties: {
      id: {
        type: "string",
      },
      status: {
        $ref: "#/components/schemas/LogStreamStatus",
      },
      datasetName: {
        type: "string",
      },
      attributes: {
        type: "array",
        items: {
          $ref: "#/components/schemas/AxiomAttribute",
        },
      },
      ingestUrl: {
        type: ["string", "null"],
      },
      topics: {
        type: ["array", "null"],
        items: {
          $ref: "#/components/schemas/LogTopic",
        },
      },
    },
  },
  ColumnSelection: {
    type: "string",
    enum: ["excluded", "included"],
  },
  ComponentSelection: {
    oneOf: [
      {
        type: "object",
        title: "Included",
        required: ["_other"],
        properties: {
          _other: {
            $ref: "#/components/schemas/InclusionDefault",
          },
        },
        additionalProperties: {
          $ref: "#/components/schemas/TableSelection",
        },
      },
      {
        oneOf: [
          {
            $ref: "#/components/schemas/ExcludedTag",
          },
        ],
        title: "Excluded",
      },
    ],
  },
  CreateAxiomLogStreamArgs: {
    type: "object",
    required: ["apiKey", "datasetName", "attributes"],
    properties: {
      apiKey: {
        type: "string",
      },
      datasetName: {
        type: "string",
      },
      attributes: {
        type: "array",
        items: {
          $ref: "#/components/schemas/AxiomAttribute",
        },
      },
      ingestUrl: {
        type: ["string", "null"],
      },
      topics: {
        type: ["array", "null"],
        items: {
          $ref: "#/components/schemas/LogTopic",
        },
      },
    },
  },
  CreateDatadogLogStreamArgs: {
    type: "object",
    required: ["siteLocation", "ddApiKey", "ddTags"],
    properties: {
      siteLocation: {
        $ref: "#/components/schemas/DatadogSiteLocation",
      },
      ddApiKey: {
        type: "string",
      },
      ddTags: {
        type: "array",
        items: {
          type: "string",
        },
      },
      service: {
        type: ["string", "null"],
      },
      topics: {
        type: ["array", "null"],
        items: {
          $ref: "#/components/schemas/LogTopic",
        },
      },
    },
  },
  CreateLogStreamArgs: {
    oneOf: [
      {
        allOf: [
          {
            $ref: "#/components/schemas/CreateDatadogLogStreamArgs",
          },
          {
            type: "object",
            required: ["logStreamType"],
            properties: {
              logStreamType: {
                type: "string",
                enum: ["datadog"],
              },
            },
          },
        ],
        title: "Datadog",
      },
      {
        allOf: [
          {
            $ref: "#/components/schemas/CreateWebhookLogStreamArgs",
          },
          {
            type: "object",
            required: ["logStreamType"],
            properties: {
              logStreamType: {
                type: "string",
                enum: ["webhook"],
              },
            },
          },
        ],
        title: "Webhook",
      },
      {
        allOf: [
          {
            $ref: "#/components/schemas/CreateAxiomLogStreamArgs",
          },
          {
            type: "object",
            required: ["logStreamType"],
            properties: {
              logStreamType: {
                type: "string",
                enum: ["axiom"],
              },
            },
          },
        ],
        title: "Axiom",
      },
      {
        allOf: [
          {
            $ref: "#/components/schemas/CreateSentryLogStreamArgs",
          },
          {
            type: "object",
            required: ["logStreamType"],
            properties: {
              logStreamType: {
                type: "string",
                enum: ["sentry"],
              },
            },
          },
        ],
        title: "Sentry",
      },
      {
        allOf: [
          {
            $ref: "#/components/schemas/CreatePostHogLogsLogStreamArgs",
          },
          {
            type: "object",
            required: ["logStreamType"],
            properties: {
              logStreamType: {
                type: "string",
                enum: ["postHogLogs"],
              },
            },
          },
        ],
        title: "PostHogLogs",
      },
      {
        allOf: [
          {
            $ref: "#/components/schemas/CreatePostHogErrorTrackingLogStreamArgs",
          },
          {
            type: "object",
            required: ["logStreamType"],
            properties: {
              logStreamType: {
                type: "string",
                enum: ["postHogErrorTracking"],
              },
            },
          },
        ],
        title: "PostHogErrorTracking",
      },
      {
        allOf: [
          {
            $ref: "#/components/schemas/CreateS3ExportLogStreamArgs",
          },
          {
            type: "object",
            required: ["logStreamType"],
            properties: {
              logStreamType: {
                type: "string",
                enum: ["s3Export"],
              },
            },
          },
        ],
        title: "S3Export",
      },
    ],
  },
  CreateLogStreamResponse: {
    oneOf: [
      {
        allOf: [
          {
            $ref: "#/components/schemas/CreateWebhookLogStreamResponse",
          },
          {
            type: "object",
            required: ["logStreamType"],
            properties: {
              logStreamType: {
                type: "string",
                enum: ["webhook"],
              },
            },
          },
        ],
        title: "Webhook",
      },
      {
        type: "object",
        title: "Datadog",
        required: ["id", "logStreamType"],
        properties: {
          id: {
            type: "string",
          },
          logStreamType: {
            type: "string",
            enum: ["datadog"],
          },
        },
      },
      {
        type: "object",
        title: "Axiom",
        required: ["id", "logStreamType"],
        properties: {
          id: {
            type: "string",
          },
          logStreamType: {
            type: "string",
            enum: ["axiom"],
          },
        },
      },
      {
        type: "object",
        title: "Sentry",
        required: ["id", "logStreamType"],
        properties: {
          id: {
            type: "string",
          },
          logStreamType: {
            type: "string",
            enum: ["sentry"],
          },
        },
      },
      {
        type: "object",
        title: "PostHogLogs",
        required: ["id", "logStreamType"],
        properties: {
          id: {
            type: "string",
          },
          logStreamType: {
            type: "string",
            enum: ["postHogLogs"],
          },
        },
      },
      {
        type: "object",
        title: "PostHogErrorTracking",
        required: ["id", "logStreamType"],
        properties: {
          id: {
            type: "string",
          },
          logStreamType: {
            type: "string",
            enum: ["postHogErrorTracking"],
          },
        },
      },
      {
        type: "object",
        title: "S3Export",
        required: ["id", "logStreamType"],
        properties: {
          id: {
            type: "string",
          },
          logStreamType: {
            type: "string",
            enum: ["s3Export"],
          },
        },
      },
    ],
  },
  CreatePostHogErrorTrackingLogStreamArgs: {
    type: "object",
    required: ["apiKey"],
    properties: {
      apiKey: {
        type: "string",
      },
      host: {
        type: ["string", "null"],
      },
    },
  },
  CreatePostHogLogsLogStreamArgs: {
    type: "object",
    required: ["apiKey"],
    properties: {
      apiKey: {
        type: "string",
      },
      host: {
        type: ["string", "null"],
      },
      serviceName: {
        type: ["string", "null"],
      },
      topics: {
        type: ["array", "null"],
        items: {
          $ref: "#/components/schemas/LogTopic",
        },
      },
    },
  },
  CreateS3ExportLogStreamArgs: {
    type: "object",
    required: ["bucket", "region", "accessKeyId", "secretAccessKey", "period"],
    properties: {
      bucket: {
        type: "string",
      },
      region: {
        type: "string",
      },
      prefix: {
        type: ["string", "null"],
      },
      accessKeyId: {
        type: "string",
      },
      secretAccessKey: {
        type: "string",
      },
      selection: {
        oneOf: [
          {
            type: "null",
          },
          {
            $ref: "#/components/schemas/Selection",
          },
        ],
      },
      period: {
        $ref: "#/components/schemas/SyncPeriod",
      },
    },
  },
  CreateSentryLogStreamArgs: {
    type: "object",
    required: ["dsn"],
    properties: {
      dsn: {
        type: "string",
      },
      tags: {
        type: ["object", "null"],
        additionalProperties: {
          type: "string",
        },
        propertyNames: {
          type: "string",
        },
      },
    },
  },
  CreateWebhookLogStreamArgs: {
    type: "object",
    required: ["url", "format"],
    properties: {
      url: {
        type: "string",
      },
      format: {
        $ref: "#/components/schemas/WebhookFormat",
      },
      topics: {
        type: ["array", "null"],
        items: {
          $ref: "#/components/schemas/LogTopic",
        },
      },
    },
  },
  CreateWebhookLogStreamResponse: {
    type: "object",
    required: ["id", "hmacSecret"],
    properties: {
      id: {
        type: "string",
      },
      hmacSecret: {
        type: "string",
        description: "The secret each request's signature is computed with.",
      },
    },
  },
  DataSyncArgs: {
    type: "object",
    properties: {
      cursor: {
        type: ["string", "null"],
        description: "The `nextCursor` of the previous page; none for the first page.",
      },
      selection: {
        $ref: "#/components/schemas/Selection",
        description: "The components, tables and columns to sync; everything when absent.",
      },
    },
  },
  DataSyncResponse: {
    type: "object",
    description: "One page of a data sync.",
    required: ["status", "truncates", "values", "syncId", "pagination"],
    properties: {
      status: {
        $ref: "#/components/schemas/DataSyncStatus",
      },
      truncates: {
        type: "array",
        items: {
          $ref: "#/components/schemas/DataSyncTruncate",
        },
        description: "Tables to empty before applying `values`: they are synced again from the start.",
      },
      values: {
        type: "array",
        items: {
          $ref: "#/components/schemas/DataSyncValue",
        },
        description: "The documents written or deleted, in the order to apply them.",
      },
      syncId: {
        $ref: "#/components/schemas/SyncId",
      },
      pagination: {
        $ref: "#/components/schemas/PaginationMetadata",
        description: "The sync never ends: `hasMore` is always true and `nextCursor` always set.",
      },
    },
  },
  DataSyncSnapshotting: {
    type: "object",
    required: ["type"],
    properties: {
      type: {
        oneOf: [
          {
            type: "string",
            enum: ["snapshotting"],
          },
        ],
      },
    },
  },
  DataSyncStale: {
    type: "object",
    required: ["type", "snapshotTs"],
    properties: {
      type: {
        oneOf: [
          {
            type: "string",
            enum: ["stale"],
          },
        ],
      },
      snapshotTs: {
        type: "integer",
        format: "int64",
      },
    },
  },
  DataSyncStatus: {
    oneOf: [
      {
        $ref: "#/components/schemas/DataSyncSnapshotting",
      },
      {
        $ref: "#/components/schemas/DataSyncStale",
      },
      {
        $ref: "#/components/schemas/DataSyncUpToDate",
      },
    ],
    discriminator: {
      propertyName: "type",
      mapping: {
        snapshotting: "#/components/schemas/DataSyncSnapshotting",
        stale: "#/components/schemas/DataSyncStale",
        upToDate: "#/components/schemas/DataSyncUpToDate",
      },
    },
  },
  DataSyncTruncate: {
    type: "object",
    required: ["component", "table"],
    properties: {
      component: {
        type: "string",
      },
      table: {
        type: "string",
      },
    },
  },
  DataSyncUpToDate: {
    type: "object",
    required: ["type", "snapshotTs"],
    properties: {
      type: {
        oneOf: [
          {
            type: "string",
            enum: ["upToDate"],
          },
        ],
      },
      snapshotTs: {
        type: "integer",
        format: "int64",
      },
    },
  },
  DataSyncValue: {
    type: "object",
    required: ["component", "table", "ts", "deleted", "value"],
    properties: {
      component: {
        type: "string",
      },
      table: {
        type: "string",
      },
      ts: {
        type: "integer",
        format: "int64",
        description: "The timestamp of the write.",
      },
      deleted: {
        type: "boolean",
      },
      value: {
        type: "object",
        description: "The document's fields, or only its `_id` when it was deleted.",
      },
    },
  },
  DatadogLogStreamConfig: {
    type: "object",
    title: "DatadogConfig",
    required: ["id", "status", "siteLocation", "ddTags"],
    properties: {
      id: {
        type: "string",
      },
      status: {
        $ref: "#/components/schemas/LogStreamStatus",
      },
      siteLocation: {
        $ref: "#/components/schemas/DatadogSiteLocation",
      },
      ddTags: {
        type: "array",
        items: {
          type: "string",
        },
      },
      service: {
        type: ["string", "null"],
      },
      topics: {
        type: ["array", "null"],
        items: {
          $ref: "#/components/schemas/LogTopic",
        },
      },
    },
  },
  DatadogSiteLocation: {
    type: "string",
    enum: ["US1", "US3", "US5", "EU", "US1_FED", "AP1"],
  },
  DeploymentAuditLogEventResponse: {
    type: "object",
    required: ["actor", "action", "createTime", "metadata"],
    properties: {
      actor: {
        $ref: "#/components/schemas/AuditLogActor",
      },
      action: {
        type: "string",
        enum: [
          "create_environment_variable",
          "update_environment_variable",
          "delete_environment_variable",
          "create_usage_limit",
          "update_usage_limit",
          "delete_usage_limit",
          "usage_limit_exceeded",
          "change_usage_limit_stop_state",
          "replace_environment_variable",
          "update_canonical_url",
          "delete_canonical_url",
          "push_config",
          "push_config_with_components",
          "build_indexes",
          "change_deployment_state",
          "pause_deployment",
          "unpause_deployment",
          "change_system_stop_state",
          "clear_tables",
          "snapshot_import",
          "delete_scheduled_jobs_table",
          "delete_tables",
          "delete_component",
          "cancel_all_scheduled_functions",
          "cancel_scheduled_function",
          "request_export",
          "cancel_export",
          "set_export_expiration",
          "create_integration",
          "update_integration",
          "delete_integration",
          "add_documents",
          "delete_documents",
          "update_documents",
          "create_table",
          "delete_files",
          "generate_upload_url",
          "create_data_sync",
        ],
      },
      createTime: {
        type: "integer",
        format: "int64",
        description: "When it happened, in milliseconds since the epoch.",
      },
      metadata: {
        $ref: "#/components/schemas/Value",
      },
      clientIp: {
        type: ["string", "null"],
        description: "The address the request came from, when known.",
      },
      clientUserAgent: {
        type: ["string", "null"],
        description: "The request's user agent, when known.",
      },
    },
  },
  ExcludedTag: {
    type: "string",
    title: "Excluded",
    enum: ["excluded"],
  },
  GetCanonicalUrlsResponse: {
    type: "object",
    required: ["bunvexCloudUrl", "bunvexSiteUrl"],
    properties: {
      bunvexCloudUrl: {
        type: "string",
      },
      bunvexSiteUrl: {
        type: "string",
      },
    },
  },
  GetCurrentUsageResponse: {
    type: "object",
    required: ["metrics", "seedStatus"],
    properties: {
      metrics: {
        type: "object",
        additionalProperties: {
          $ref: "#/components/schemas/MetricUsageResponse",
        },
        propertyNames: {
          type: "string",
        },
        description: "Each usage limit metric's usage, by its name.",
      },
      seedStatus: {
        $ref: "#/components/schemas/SeedStatusResponse",
        description: "Whether the windows' usage includes what came before the server started.",
      },
    },
  },
  InclusionDefault: {
    type: "string",
    enum: ["excluded", "included"],
  },
  ListActiveSyncsResponse: {
    type: "object",
    required: ["syncs", "pagination"],
    properties: {
      syncs: {
        type: "array",
        items: {
          $ref: "#/components/schemas/ActiveDataSync",
        },
        description: "The syncs that fetched a page in the last 3 days, the latest first.",
      },
      pagination: {
        $ref: "#/components/schemas/PaginationMetadata",
      },
    },
  },
  ListDeploymentAuditLogEventsResponse: {
    type: "object",
    required: ["items", "pagination"],
    properties: {
      items: {
        type: "array",
        items: {
          $ref: "#/components/schemas/DeploymentAuditLogEventResponse",
        },
        description: "The page's events, the oldest first.",
      },
      pagination: {
        $ref: "#/components/schemas/PaginationMetadata",
      },
    },
  },
  ListEnvVarsResponse: {
    type: "object",
    required: ["environmentVariables"],
    properties: {
      environmentVariables: {
        type: "object",
        additionalProperties: {
          type: "string",
        },
        propertyNames: {
          type: "string",
        },
        description: "Each variable's value, by its name.",
      },
    },
  },
  ListUsageLimitsResponse: {
    type: "object",
    required: ["usageLimits"],
    properties: {
      usageLimits: {
        type: "array",
        items: {
          $ref: "#/components/schemas/UsageLimitConfigResponse",
        },
      },
    },
  },
  LogStreamConfig: {
    oneOf: [
      {
        allOf: [
          {
            $ref: "#/components/schemas/DatadogLogStreamConfig",
          },
          {
            type: "object",
            required: ["logStreamType"],
            properties: {
              logStreamType: {
                type: "string",
                enum: ["datadog"],
              },
            },
          },
        ],
        title: "Datadog",
      },
      {
        allOf: [
          {
            $ref: "#/components/schemas/WebhookLogStreamConfig",
          },
          {
            type: "object",
            required: ["logStreamType"],
            properties: {
              logStreamType: {
                type: "string",
                enum: ["webhook"],
              },
            },
          },
        ],
        title: "Webhook",
      },
      {
        allOf: [
          {
            $ref: "#/components/schemas/AxiomLogStreamConfig",
          },
          {
            type: "object",
            required: ["logStreamType"],
            properties: {
              logStreamType: {
                type: "string",
                enum: ["axiom"],
              },
            },
          },
        ],
        title: "Axiom",
      },
      {
        allOf: [
          {
            $ref: "#/components/schemas/SentryLogStreamConfig",
          },
          {
            type: "object",
            required: ["logStreamType"],
            properties: {
              logStreamType: {
                type: "string",
                enum: ["sentry"],
              },
            },
          },
        ],
        title: "Sentry",
      },
      {
        allOf: [
          {
            $ref: "#/components/schemas/PostHogLogsLogStreamConfig",
          },
          {
            type: "object",
            required: ["logStreamType"],
            properties: {
              logStreamType: {
                type: "string",
                enum: ["postHogLogs"],
              },
            },
          },
        ],
        title: "PostHogLogs",
      },
      {
        allOf: [
          {
            $ref: "#/components/schemas/PostHogErrorTrackingLogStreamConfig",
          },
          {
            type: "object",
            required: ["logStreamType"],
            properties: {
              logStreamType: {
                type: "string",
                enum: ["postHogErrorTracking"],
              },
            },
          },
        ],
        title: "PostHogErrorTracking",
      },
      {
        allOf: [
          {
            $ref: "#/components/schemas/S3ExportLogStreamConfig",
          },
          {
            type: "object",
            required: ["logStreamType"],
            properties: {
              logStreamType: {
                type: "string",
                enum: ["s3Export"],
              },
            },
          },
        ],
        title: "S3Export",
      },
    ],
  },
  LogStreamStatus: {
    oneOf: [
      {
        type: "object",
        required: ["type"],
        properties: {
          type: {
            type: "string",
            enum: ["pending"],
          },
        },
      },
      {
        type: "object",
        required: ["type"],
        properties: {
          type: {
            type: "string",
            enum: ["restarting"],
          },
        },
      },
      {
        type: "object",
        required: ["reason", "type"],
        properties: {
          reason: {
            type: "string",
          },
          type: {
            type: "string",
            enum: ["failed"],
          },
        },
      },
      {
        type: "object",
        required: ["type"],
        properties: {
          type: {
            type: "string",
            enum: ["active"],
          },
        },
      },
      {
        type: "object",
        required: ["type"],
        properties: {
          type: {
            type: "string",
            enum: ["deleting"],
          },
        },
      },
    ],
  },
  LogTopic: {
    type: "string",
    description: "A kind of event a log stream can receive.",
    enum: [
      "verification",
      "console",
      "function_execution",
      "exception",
      "audit_log",
      "scheduler_stats",
      "scheduled_job_lag",
      "current_storage_usage",
      "concurrency_stats",
      "storage_api_bandwidth",
      "ai_gateway_usage",
      "log_stream_egress",
      "custom_audit",
    ],
  },
  MemberId: {
    type: "integer",
    format: "int64",
    minimum: 0,
  },
  MetricUnit: {
    type: "string",
    enum: ["calls", "GB", "Query-GB", "GB-hours", "dollars"],
  },
  MetricUsageResponse: {
    type: "object",
    required: ["unit", "usage"],
    properties: {
      unit: {
        $ref: "#/components/schemas/MetricUnit",
      },
      usage: {
        $ref: "#/components/schemas/WindowUsageResponse",
      },
    },
  },
  PaginationMetadata: {
    type: "object",
    required: ["hasMore"],
    properties: {
      hasMore: {
        type: "boolean",
      },
      nextCursor: {
        type: ["string", "null"],
      },
    },
  },
  PostHogErrorTrackingLogStreamConfig: {
    type: "object",
    title: "PostHogErrorTrackingConfig",
    required: ["id", "status"],
    properties: {
      id: {
        type: "string",
      },
      status: {
        $ref: "#/components/schemas/LogStreamStatus",
      },
      host: {
        type: ["string", "null"],
      },
    },
  },
  PostHogLogsLogStreamConfig: {
    type: "object",
    title: "PostHogLogsConfig",
    required: ["id", "status"],
    properties: {
      id: {
        type: "string",
      },
      status: {
        $ref: "#/components/schemas/LogStreamStatus",
      },
      host: {
        type: ["string", "null"],
      },
      serviceName: {
        type: ["string", "null"],
      },
      topics: {
        type: ["array", "null"],
        items: {
          $ref: "#/components/schemas/LogTopic",
        },
      },
    },
  },
  RequestDestination: {
    type: "string",
    enum: ["bunvexCloud", "bunvexSite"],
  },
  RotateLogStreamSecretResponse: {
    oneOf: [
      {
        type: "object",
        title: "Webhook",
        required: ["hmacSecret", "logStreamType"],
        properties: {
          hmacSecret: {
            type: "string",
          },
          logStreamType: {
            type: "string",
            enum: ["webhook"],
          },
        },
      },
    ],
  },
  S3ExportLogStreamConfig: {
    type: "object",
    title: "S3ExportConfig",
    required: ["id", "status", "bucket", "region", "accessKeyId", "selection", "period"],
    properties: {
      id: {
        type: "string",
      },
      status: {
        $ref: "#/components/schemas/LogStreamStatus",
      },
      bucket: {
        type: "string",
      },
      region: {
        type: "string",
      },
      prefix: {
        type: ["string", "null"],
      },
      accessKeyId: {
        type: "string",
      },
      selection: {
        $ref: "#/components/schemas/Selection",
      },
      period: {
        $ref: "#/components/schemas/SyncPeriod",
      },
    },
  },
  SeedStatusResponse: {
    type: "string",
    enum: ["pending", "partial", "complete", "failed"],
  },
  Selection: {
    type: "object",
    description: 'What to sync: components by path (the root component is `""`), and what `_other` ones get.',
    required: ["_other"],
    properties: {
      _other: {
        $ref: "#/components/schemas/InclusionDefault",
      },
    },
    additionalProperties: {
      $ref: "#/components/schemas/ComponentSelection",
    },
    example: {
      _other: "excluded",
      "": {
        _other: "excluded",
        posts: {
          _other: "included",
        },
        users: {
          _other: "included",
          ssn: "excluded",
        },
      },
    },
  },
  SentryLogStreamConfig: {
    type: "object",
    title: "SentryConfig",
    required: ["id", "status"],
    properties: {
      id: {
        type: "string",
      },
      status: {
        $ref: "#/components/schemas/LogStreamStatus",
      },
      tags: {
        type: ["object", "null"],
        additionalProperties: {
          type: "string",
        },
        propertyNames: {
          type: "string",
        },
      },
    },
  },
  SyncId: {
    type: "string",
  },
  SyncPeriod: {
    type: "string",
    enum: ["continuous", "hourly", "daily"],
  },
  TableSelection: {
    oneOf: [
      {
        type: "object",
        title: "Included",
        required: ["_other"],
        properties: {
          _other: {
            $ref: "#/components/schemas/InclusionDefault",
          },
        },
        additionalProperties: {
          $ref: "#/components/schemas/ColumnSelection",
        },
      },
      {
        oneOf: [
          {
            $ref: "#/components/schemas/ExcludedTag",
          },
        ],
        title: "Excluded",
      },
    ],
  },
  UpdateAxiomSinkArgs: {
    type: "object",
    properties: {
      apiKey: {
        type: ["string", "null"],
      },
      datasetName: {
        type: ["string", "null"],
      },
      attributes: {
        type: ["array", "null"],
        items: {
          $ref: "#/components/schemas/AxiomAttribute",
        },
      },
      ingestUrl: {
        type: ["string", "null"],
      },
      topics: {
        type: ["array", "null"],
        items: {
          $ref: "#/components/schemas/LogTopic",
        },
      },
    },
  },
  UpdateCanonicalUrlRequest: {
    type: "object",
    required: ["requestDestination"],
    properties: {
      requestDestination: {
        $ref: "#/components/schemas/RequestDestination",
      },
      url: {
        type: ["string", "null"],
        description: "The URL; none to go back to the server's own.",
      },
    },
  },
  UpdateDatadogSinkArgs: {
    type: "object",
    properties: {
      siteLocation: {
        oneOf: [
          {
            type: "null",
          },
          {
            $ref: "#/components/schemas/DatadogSiteLocation",
          },
        ],
      },
      ddApiKey: {
        type: ["string", "null"],
      },
      ddTags: {
        type: ["array", "null"],
        items: {
          type: "string",
        },
      },
      service: {
        type: ["string", "null"],
      },
      topics: {
        type: ["array", "null"],
        items: {
          $ref: "#/components/schemas/LogTopic",
        },
      },
    },
  },
  UpdateEnvVarRequest: {
    type: "object",
    required: ["name"],
    properties: {
      name: {
        type: "string",
      },
      value: {
        type: ["string", "null"],
        description: "The new value; none to delete the variable.",
      },
    },
  },
  UpdateEnvVarsRequest: {
    type: "object",
    required: ["changes"],
    properties: {
      changes: {
        type: "array",
        items: {
          $ref: "#/components/schemas/UpdateEnvVarRequest",
        },
      },
    },
  },
  UpdateLogStreamArgs: {
    oneOf: [
      {
        allOf: [
          {
            $ref: "#/components/schemas/UpdateDatadogSinkArgs",
          },
          {
            type: "object",
            required: ["logStreamType"],
            properties: {
              logStreamType: {
                type: "string",
                enum: ["datadog"],
              },
            },
          },
        ],
        title: "Datadog",
      },
      {
        allOf: [
          {
            $ref: "#/components/schemas/UpdateWebhookSinkArgs",
          },
          {
            type: "object",
            required: ["logStreamType"],
            properties: {
              logStreamType: {
                type: "string",
                enum: ["webhook"],
              },
            },
          },
        ],
        title: "Webhook",
      },
      {
        allOf: [
          {
            $ref: "#/components/schemas/UpdateAxiomSinkArgs",
          },
          {
            type: "object",
            required: ["logStreamType"],
            properties: {
              logStreamType: {
                type: "string",
                enum: ["axiom"],
              },
            },
          },
        ],
        title: "Axiom",
      },
      {
        allOf: [
          {
            $ref: "#/components/schemas/UpdateSentrySinkArgs",
          },
          {
            type: "object",
            required: ["logStreamType"],
            properties: {
              logStreamType: {
                type: "string",
                enum: ["sentry"],
              },
            },
          },
        ],
        title: "Sentry",
      },
      {
        allOf: [
          {
            $ref: "#/components/schemas/UpdatePostHogLogsSinkArgs",
          },
          {
            type: "object",
            required: ["logStreamType"],
            properties: {
              logStreamType: {
                type: "string",
                enum: ["postHogLogs"],
              },
            },
          },
        ],
        title: "PostHogLogs",
      },
      {
        allOf: [
          {
            $ref: "#/components/schemas/UpdatePostHogErrorTrackingSinkArgs",
          },
          {
            type: "object",
            required: ["logStreamType"],
            properties: {
              logStreamType: {
                type: "string",
                enum: ["postHogErrorTracking"],
              },
            },
          },
        ],
        title: "PostHogErrorTracking",
      },
      {
        allOf: [
          {
            $ref: "#/components/schemas/UpdateS3ExportSinkArgs",
          },
          {
            type: "object",
            required: ["logStreamType"],
            properties: {
              logStreamType: {
                type: "string",
                enum: ["s3Export"],
              },
            },
          },
        ],
        title: "S3Export",
      },
    ],
  },
  UpdatePostHogErrorTrackingSinkArgs: {
    type: "object",
    properties: {
      apiKey: {
        type: ["string", "null"],
      },
      host: {
        type: ["string", "null"],
      },
    },
  },
  UpdatePostHogLogsSinkArgs: {
    type: "object",
    properties: {
      apiKey: {
        type: ["string", "null"],
      },
      host: {
        type: ["string", "null"],
      },
      serviceName: {
        type: ["string", "null"],
      },
      topics: {
        type: ["array", "null"],
        items: {
          $ref: "#/components/schemas/LogTopic",
        },
      },
    },
  },
  UpdateS3ExportSinkArgs: {
    type: "object",
    properties: {
      bucket: {
        type: ["string", "null"],
      },
      region: {
        type: ["string", "null"],
      },
      prefix: {
        type: ["string", "null"],
      },
      accessKeyId: {
        type: ["string", "null"],
      },
      secretAccessKey: {
        type: ["string", "null"],
      },
      selection: {
        oneOf: [
          {
            type: "null",
          },
          {
            $ref: "#/components/schemas/Selection",
          },
        ],
      },
      period: {
        oneOf: [
          {
            type: "null",
          },
          {
            $ref: "#/components/schemas/SyncPeriod",
          },
        ],
      },
    },
  },
  UpdateSentrySinkArgs: {
    type: "object",
    properties: {
      dsn: {
        type: ["string", "null"],
      },
      tags: {
        type: ["object", "null"],
        additionalProperties: {
          type: "string",
        },
        propertyNames: {
          type: "string",
        },
      },
    },
  },
  UpdateWebhookSinkArgs: {
    type: "object",
    properties: {
      url: {
        type: ["string", "null"],
      },
      format: {
        oneOf: [
          {
            type: "null",
          },
          {
            $ref: "#/components/schemas/WebhookFormat",
          },
        ],
      },
      topics: {
        type: ["array", "null"],
        items: {
          $ref: "#/components/schemas/LogTopic",
        },
      },
    },
  },
  UsageLimitConfigRequest: {
    type: "object",
    required: ["metric", "window", "limitType", "limit", "enabled"],
    properties: {
      metric: {
        $ref: "#/components/schemas/UsageLimitMetric",
      },
      window: {
        $ref: "#/components/schemas/UsageLimitWindow",
      },
      limitType: {
        $ref: "#/components/schemas/UsageLimitType",
      },
      limit: {
        type: "integer",
        format: "int64",
        minimum: 1,
        description: "The limit, in the metric's unit.",
      },
      enabled: {
        type: "boolean",
      },
    },
  },
  UsageLimitConfigResponse: {
    type: "object",
    required: ["id", "metric", "window", "limitType", "limit", "enabled"],
    properties: {
      id: {
        type: "string",
      },
      metric: {
        $ref: "#/components/schemas/UsageLimitMetric",
      },
      window: {
        $ref: "#/components/schemas/UsageLimitWindow",
      },
      limitType: {
        $ref: "#/components/schemas/UsageLimitType",
      },
      limit: {
        type: "integer",
        format: "int64",
        minimum: 1,
      },
      enabled: {
        type: "boolean",
      },
    },
  },
  UsageLimitMetric: {
    type: "string",
    enum: [
      "functionCalls",
      "databaseIoGb",
      "dataEgressGb",
      "searchQueryGb",
      "queryMutationComputeGbHours",
      "actionComputeIsolateGbHours",
      "actionComputeNodeJsGbHours",
      "actionComputeCpuGbHours",
      "aiGatewayCostDollars",
    ],
  },
  UsageLimitResponse: {
    type: "object",
    required: ["usageLimit"],
    properties: {
      usageLimit: {
        $ref: "#/components/schemas/UsageLimitConfigResponse",
      },
    },
  },
  UsageLimitType: {
    type: "string",
    enum: ["warning", "disable"],
  },
  UsageLimitWindow: {
    type: "string",
    enum: ["day", "month"],
  },
  Value: {},
  WebhookFormat: {
    type: "string",
    enum: ["json", "jsonl"],
  },
  WebhookLogStreamConfig: {
    type: "object",
    title: "WebhookConfig",
    required: ["id", "status", "url", "format", "hmacSecret"],
    properties: {
      id: {
        type: "string",
      },
      status: {
        $ref: "#/components/schemas/LogStreamStatus",
      },
      url: {
        type: "string",
      },
      format: {
        $ref: "#/components/schemas/WebhookFormat",
      },
      hmacSecret: {
        type: "string",
      },
      topics: {
        type: ["array", "null"],
        items: {
          $ref: "#/components/schemas/LogTopic",
        },
      },
    },
  },
  WindowUsageResponse: {
    type: "object",
    description: "Usage in the current UTC day and month, in the metric's unit.",
    required: ["current_day", "current_month"],
    properties: {
      current_day: {
        type: "number",
        format: "double",
      },
      current_month: {
        type: "number",
        format: "double",
      },
    },
  },
};

/** `/api/dashboard_openapi.json`: the dashboard routes' schemas. */
export const DASHBOARD_SCHEMAS: Record<string, JsonSchema> = {
  DeleteScheduledFunctionsTableRequest: {
    type: "object",
    properties: {
      componentId: {
        type: ["string", "null"],
      },
    },
  },
  DeleteTableArgs: {
    type: "object",
    required: ["tableNames"],
    properties: {
      tableNames: {
        type: "array",
        items: {
          type: "string",
        },
        description: "The tables to delete, in one transaction.",
      },
      componentId: {
        type: ["string", "null"],
      },
    },
  },
};

/** `/api/public_openapi.json`: the function API's schemas. */
export const PUBLIC_SCHEMAS: Record<string, JsonSchema> = {
  QueryBatchArgs: {
    type: "object",
    required: ["queries"],
    properties: {
      queries: {
        type: "array",
        items: {
          $ref: "#/components/schemas/UdfPostRequest",
        },
      },
    },
  },
  QueryBatchResponse: {
    type: "object",
    required: ["results"],
    properties: {
      results: {
        type: "array",
        items: {
          $ref: "#/components/schemas/UdfResponse",
        },
      },
    },
  },
  SerializedTs: {
    type: "string",
  },
  Ts: {
    type: "object",
    required: ["ts"],
    properties: {
      ts: {
        $ref: "#/components/schemas/SerializedTs",
        description: "A timestamp, for `/query_at_ts`.",
      },
    },
  },
  UdfPostRequest: {
    type: "object",
    required: ["path", "args"],
    properties: {
      path: {
        type: "string",
      },
      args: {
        type: "object",
      },
      format: {
        type: ["string", "null"],
        description:
          "How values are written in the answer: `json`, `encoded_json` or `export_json`; by default, what the client expects.",
      },
    },
  },
  UdfPostRequestArgsOnly: {
    type: "object",
    required: ["args"],
    properties: {
      args: {
        type: "object",
      },
      format: {
        type: ["string", "null"],
      },
    },
  },
  UdfPostRequestWithComponent: {
    type: "object",
    description: "Any function by its path, internal ones included. Needs an admin key.",
    required: ["path", "args"],
    properties: {
      componentPath: {
        type: ["string", "null"],
      },
      path: {
        type: "string",
      },
      args: {
        type: "object",
      },
      format: {
        type: ["string", "null"],
      },
    },
  },
  UdfPostWithTsRequest: {
    type: "object",
    required: ["path", "args", "ts"],
    properties: {
      path: {
        type: "string",
      },
      args: {
        type: "object",
      },
      ts: {
        $ref: "#/components/schemas/SerializedTs",
      },
      format: {
        type: ["string", "null"],
      },
    },
  },
  UdfResponse: {
    oneOf: [
      {
        type: "object",
        required: ["value", "status"],
        properties: {
          value: {
            $ref: "#/components/schemas/Value",
          },
          logLines: {
            type: "array",
            items: {
              type: "string",
            },
          },
          status: {
            type: "string",
            enum: ["success"],
          },
        },
      },
      {
        type: "object",
        required: ["errorMessage", "status"],
        properties: {
          errorMessage: {
            type: "string",
          },
          errorData: {
            oneOf: [
              {
                type: "null",
              },
              {
                $ref: "#/components/schemas/Value",
              },
            ],
          },
          logLines: {
            type: "array",
            items: {
              type: "string",
            },
          },
          status: {
            type: "string",
            enum: ["error"],
          },
        },
      },
    ],
  },
  Value: {},
};
