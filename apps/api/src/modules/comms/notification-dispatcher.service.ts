import { Inject, Injectable } from "@nestjs/common";
import { Channel, renderTemplate } from "@svyft/shared";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { MessageTemplateService } from "./message-template.service";
import { MESSAGE_TRANSPORT, type MessageTransport } from "./transport";

const FROM = "logistics@yankalfa.com";

export type DispatchInput = {
  scope: { entityType: string; entityId: string };
  tokens: Record<string, string>;
  recipients: { IN_APP?: string[]; EMAIL?: string[] };
  composedById?: string | null;
  tenantId?: string | null;
};

@Injectable()
export class NotificationDispatcher {
  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: MessageTemplateService,
    @Inject(MESSAGE_TRANSPORT) private readonly transport: MessageTransport,
  ) {}

  async dispatch(eventKey: string, input: DispatchInput): Promise<void> {
    const { scope, tokens } = input;

    const inApp = input.recipients.IN_APP ?? [];
    if (inApp.length) {
      const tpl = await this.templates.lookup(eventKey, Channel.IN_APP);
      if (tpl) {
        const message = renderTemplate(tpl.body, tokens);
        await this.prisma.notification.createMany({
          data: inApp.map((recipientUserId) => ({
            recipientUserId,
            type: eventKey,
            entityType: scope.entityType,
            entityId: scope.entityId,
            queryId: scope.entityType === "QUERY" ? scope.entityId : null,
            message,
            tenantId: input.tenantId ?? null,
          })),
        });
      }
    }

    const emails = input.recipients.EMAIL ?? [];
    if (emails.length) {
      const tpl = await this.templates.lookup(eventKey, Channel.EMAIL);
      if (tpl) {
        const subject = renderTemplate(tpl.subject ?? "", tokens);
        const body = renderTemplate(tpl.body, tokens);
        for (const to of emails) {
          const log = await this.prisma.messageLog.create({
            data: {
              entityType: scope.entityType,
              entityId: scope.entityId,
              eventKey,
              channel: Channel.EMAIL,
              templateKey: tpl.key,
              fromAddress: FROM,
              toAddress: to,
              subject,
              bodyRendered: body,
              tokens: tokens as unknown as Prisma.InputJsonValue,
              composedById: input.composedById ?? null,
              tenantId: input.tenantId ?? null,
            },
          });
          await this.transport.send(log.id);
        }
      }
    }
  }
}
