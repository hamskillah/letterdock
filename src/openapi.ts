export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'Letterdock Sovereign Email API',
    version: '1.0.0',
    description: 'Autonomous Inbound & Outbound Email Infrastructure with Drop-In Resend SDK Parity.'
  },
  servers: [
    {
      url: '/',
      description: 'Current Letterdock instance'
    }
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Letterdock API Key (re_...) or Ingress Key'
      }
    },
    schemas: {
      Email: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          from: { type: 'string' },
          to: { type: 'array', items: { type: 'string' } },
          subject: { type: 'string' },
          html: { type: 'string' },
          text: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
          last_event: { type: 'string', enum: ['queued', 'sending', 'sent', 'delivered', 'failed', 'bounced'] }
        }
      },
      SendEmailRequest: {
        type: 'object',
        required: ['from', 'to', 'subject'],
        properties: {
          from: { type: 'string', example: 'hello@example.com' },
          to: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } }
            ],
            example: 'user@destination.com'
          },
          subject: { type: 'string', example: 'Hello from Letterdock' },
          html: { type: 'string', example: '<p>Welcome!</p>' },
          text: { type: 'string', example: 'Welcome!' },
          cc: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          bcc: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          reply_to: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          attachments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                filename: { type: 'string' },
                content: { type: 'string' },
                path: { type: 'string' }
              }
            }
          },
          tags: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                value: { type: 'string' }
              }
            }
          }
        }
      },
      Domain: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string', enum: ['not_started', 'pending', 'verified'] },
          created_at: { type: 'string', format: 'date-time' },
          region: { type: 'string' },
          records: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                record: { type: 'string' },
                name: { type: 'string' },
                value: { type: 'string' },
                type: { type: 'string' },
                status: { type: 'string' }
              }
            }
          }
        }
      },
      ApiKey: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          token: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' }
        }
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          statusCode: { type: 'integer' },
          message: { type: 'string' }
        }
      }
    }
  },
  security: [
    {
      BearerAuth: []
    }
  ],
  paths: {
    '/emails': {
      post: {
        summary: 'Send an email (Resend SDK drop-in parity)',
        operationId: 'sendEmail',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/SendEmailRequest'
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Email dispatched successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' }
                  }
                }
              }
            }
          },
          '403': {
            description: 'Domain not verified for outbound sending',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          },
          '422': {
            description: 'Recipient suppressed or validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },
    '/emails/batch': {
      post: {
        summary: 'Send batch emails (Resend SDK parity)',
        operationId: 'sendBatchEmails',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'array',
                items: { $ref: '#/components/schemas/SendEmailRequest' }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Batch dispatched successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: { id: { type: 'string', format: 'uuid' } }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/emails/{id}': {
      get: {
        summary: 'Retrieve email status and details',
        operationId: 'getEmail',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: {
          '200': {
            description: 'Email details',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Email' } } }
          },
          '404': {
            description: 'Email not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },
    '/emails/receiving': {
      get: {
        summary: 'List incoming emails',
        operationId: 'listReceivedEmails',
        responses: {
          '200': { description: 'List of received emails' }
        }
      }
    },
    '/domains': {
      get: {
        summary: 'List domains',
        operationId: 'listDomains',
        responses: {
          '200': {
            description: 'List of domains',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Domain' } }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        summary: 'Register a new domain',
        operationId: 'createDomain',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string', example: 'example.com' }
                }
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Domain created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Domain' } } }
          }
        }
      }
    },
    '/domains/{id}': {
      get: {
        summary: 'Get domain details and DNS records',
        operationId: 'getDomain',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: {
          '200': {
            description: 'Domain details',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Domain' } } }
          }
        }
      }
    },
    '/domains/{id}/verify': {
      post: {
        summary: 'Verify domain DNS configuration',
        operationId: 'verifyDomain',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: {
          '200': { description: 'Domain verification result' }
        }
      }
    },
    '/api-keys': {
      get: {
        summary: 'List API keys',
        operationId: 'listApiKeys',
        responses: {
          '200': {
            description: 'List of API keys',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/ApiKey' } }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        summary: 'Create an API key',
        operationId: 'createApiKey',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string', example: 'Production Key' },
                  domain: { type: 'string', example: 'example.com' }
                }
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'API key created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiKey' } } }
          }
        }
      }
    },
    '/api-keys/{id}': {
      delete: {
        summary: 'Revoke an API key',
        operationId: 'deleteApiKey',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: {
          '200': { description: 'API key revoked' }
        }
      }
    },
    '/api/ingress/raw': {
      post: {
        summary: 'Direct raw RFC 822 EML stream or binary ingestion',
        operationId: 'rawIngress',
        requestBody: {
          required: true,
          content: {
            'message/rfc822': { schema: { type: 'string', format: 'binary' } },
            'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  from: { type: 'string' },
                  to: { type: 'string' },
                  raw: { type: 'string' }
                }
              }
            }
          }
        },
        responses: {
          '201': { description: 'Email accepted and queued' },
          '400': { description: 'Invalid payload or recipient' },
          '403': { description: 'Sender blocked' },
          '404': { description: 'Unknown domain' },
          '413': { description: 'Message too large' },
          '429': { description: 'Domain quota exceeded' },
          '507': { description: 'Storage quota exceeded' }
        }
      }
    },
    '/api/webhooks/bounces': {
      post: {
        summary: 'Record bounce event and update suppression list',
        operationId: 'recordBounceWebhook',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email'],
                properties: {
                  email: { type: 'string' },
                  domain: { type: 'string' },
                  reason: { type: 'string', default: 'bounce' },
                  details: { type: 'string' }
                }
              }
            }
          }
        },
        responses: {
          '200': { description: 'Bounce recorded and address suppressed' }
        }
      }
    },
    '/api/outbound/profiles': {
      get: {
        summary: 'List outbound relay profiles',
        operationId: 'listOutboundProfiles',
        responses: {
          '200': { description: 'Outbound profiles list' }
        }
      },
      post: {
        summary: 'Create or update an outbound relay profile with encrypted credentials',
        operationId: 'upsertOutboundProfile',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['domain', 'provider', 'credentials'],
                properties: {
                  domain: { type: 'string' },
                  provider: { type: 'string', enum: ['smtp', 'resend', 'ses', 'brevo', 'mock'] },
                  credentials: { type: 'object' },
                  from_name: { type: 'string' },
                  from_email: { type: 'string' },
                  is_default: { type: 'boolean' }
                }
              }
            }
          }
        },
        responses: {
          '200': { description: 'Outbound profile configured' }
        }
      }
    },
    '/api/outbound/profiles/{domain}': {
      delete: {
        summary: 'Delete outbound relay profile for domain',
        operationId: 'deleteOutboundProfile',
        parameters: [
          { name: 'domain', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: {
          '200': { description: 'Outbound profile deleted' }
        }
      }
    },
    '/api/suppressions': {
      get: {
        summary: 'List suppressed recipient email addresses',
        operationId: 'listSuppressions',
        responses: {
          '200': { description: 'Active suppression list' }
        }
      },
      post: {
        summary: 'Add an email to the suppression list',
        operationId: 'addSuppression',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  reason: { type: 'string', enum: ['bounce', 'complaint', 'manual'], default: 'manual' },
                  details: { type: 'string' },
                  domain: { type: 'string' }
                }
              }
            }
          }
        },
        responses: {
          '200': { description: 'Suppression created' }
        }
      }
    },
    '/api/suppressions/{email}': {
      delete: {
        summary: 'Remove an email from the suppression list',
        operationId: 'removeSuppression',
        parameters: [
          { name: 'email', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: {
          '200': { description: 'Suppression removed' }
        }
      }
    },
    '/api/webhooks/complaints': {
      post: {
        summary: 'Record spam complaint webhook event and suppress recipient',
        operationId: 'recordComplaintWebhook',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email'],
                properties: {
                  email: { type: 'string' },
                  domain: { type: 'string' },
                  details: { type: 'string' }
                }
              }
            }
          }
        },
        responses: {
          '200': { description: 'Complaint recorded and recipient suppressed' }
        }
      }
    }
  }
};
