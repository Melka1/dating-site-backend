import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import type { AppConfig } from '../../config/configuration';

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

interface ShellArgs {
  preheader: string;
  heading: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
  fineprint: string;
}

const LOGO_URL = 'https://oapjieahuygzttohfwdu.supabase.co/storage/v1/object/public/common/x-icon.png';
const SUPPORT_EMAIL = 'hello@turulav.app';
const BRAND_HOME = 'https://turulav.app';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly client: Resend | null;
  private readonly from: string;
  private readonly baseUrl: string;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    const apiKey = this.config.get('email.resendApiKey', { infer: true });
    const fromAddress = this.config.get('email.from', { infer: true });
    const fromName = this.config.get('email.fromName', { infer: true });
    this.from = `${fromName} <${fromAddress}>`;
    this.baseUrl = this.config.get('email.appBaseUrl', { infer: true });
    this.client = apiKey ? new Resend(apiKey) : null;
    if (!this.client) {
      this.logger.warn(
        'RESEND_API_KEY is not set — outgoing mail will be logged instead of sent',
      );
    }
  }

  private async send({ to, subject, html, text }: SendArgs): Promise<void> {
    if (!this.client) {
      this.logger.log({ msg: 'mail (dev no-op)', to, subject, text });
      return;
    }
    try {
      const { error } = await this.client.emails.send({
        from: this.from,
        to,
        subject,
        html,
        text,
      });
      if (error) {
        this.logger.error({ msg: 'resend send failed', to, subject, error });
      }
    } catch (err) {
      this.logger.error({ msg: 'resend send threw', to, subject, err });
    }
  }

  private shell({ preheader, heading, body, ctaLabel, ctaUrl, fineprint }: ShellArgs): string {
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>${heading}</title>
  </head>
  <body style="margin:0; padding:0; background-color:#fff5f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color:#2b1810;">
    <div style="display:none; max-height:0; overflow:hidden; opacity:0; visibility:hidden; mso-hide:all;">
      ${preheader}
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fff5f0;">
      <tr>
        <td align="center" style="padding: 32px 16px;">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px; width:100%; background-color:#ffffff; border-radius:20px; overflow:hidden; box-shadow: 0 8px 24px rgba(244, 96, 54, 0.08);">

            <tr>
              <td align="center" style="background: linear-gradient(135deg, #f43f5e 0%, #fb923c 100%); background-color:#f43f5e; padding: 36px 24px 28px;">
                <img src="${LOGO_URL}" alt="TuruLav" width="56" height="56" style="display:block; border:0; outline:none; text-decoration:none; border-radius:14px; background:#ffffff; padding:8px;" />
                <div style="font-size:22px; font-weight:700; color:#ffffff; letter-spacing:0.3px; margin-top:14px;">
                  TuruLav
                </div>
              </td>
            </tr>

            <tr>
              <td style="padding: 40px 40px 16px;">
                <h1 style="margin:0 0 12px; font-size:26px; line-height:1.25; font-weight:700; color:#1f1208;">
                  ${heading}
                </h1>
                <p style="margin:0 0 24px; font-size:16px; line-height:1.6; color:#5b4a40;">
                  ${body}
                </p>

                <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin: 8px auto 28px;">
                  <tr>
                    <td align="center" bgcolor="#f43f5e" style="border-radius: 999px; background: linear-gradient(135deg, #f43f5e 0%, #fb923c 100%); background-color:#f43f5e;">
                      <a href="${ctaUrl}"
                         style="display:inline-block; padding: 14px 36px; font-size:16px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:999px; letter-spacing:0.2px;">
                        ${ctaLabel}
                      </a>
                    </td>
                  </tr>
                </table>

                <p style="margin:0 0 8px; font-size:14px; line-height:1.6; color:#7a6a60;">
                  Button not working? Paste this link into your browser:
                </p>
                <p style="margin:0 0 8px; font-size:13px; line-height:1.5; word-break:break-all;">
                  <a href="${ctaUrl}" style="color:#f43f5e; text-decoration:underline;">${ctaUrl}</a>
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding: 8px 40px;">
                <div style="height:1px; background-color:#fde4d8; line-height:1px; font-size:0;">&nbsp;</div>
              </td>
            </tr>

            <tr>
              <td style="padding: 16px 40px 32px;">
                <p style="margin:0; font-size:13px; line-height:1.6; color:#8a7a70;">
                  ${fineprint}
                </p>
              </td>
            </tr>

            <tr>
              <td style="background-color:#fff5f0; padding: 24px 40px 32px;" align="center">
                <p style="margin:0 0 6px; font-size:13px; color:#9a8a80;">
                  Made with <span style="color:#f43f5e;">&hearts;</span> by the TuruLav team
                </p>
                <p style="margin:0 0 6px; font-size:12px; color:#a99a90;">
                  Need help? <a href="mailto:${SUPPORT_EMAIL}" style="color:#fb923c; text-decoration:none;">${SUPPORT_EMAIL}</a>
                </p>
                <p style="margin:0; font-size:12px; color:#a99a90;">
                  <a href="${BRAND_HOME}/privacy" style="color:#a99a90; text-decoration:underline;">Privacy</a>
                  &nbsp;&middot;&nbsp;
                  <a href="${BRAND_HOME}/terms" style="color:#a99a90; text-decoration:underline;">Terms</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
  }

  async sendNewsletterConfirmation(email: string, token: string): Promise<void> {
    const confirmUrl = `${this.baseUrl}/newsletter/confirm?token=${encodeURIComponent(token)}`;
    const subject = 'Confirm your TuruLav newsletter subscription';
    const text =
      `Thanks for signing up to the TuruLav newsletter!\n\n` +
      `Confirm your subscription:\n${confirmUrl}\n\n` +
      `This link expires in 7 days. If you didn't request this, ignore this email — you won't be subscribed.`;
    const html = this.shell({
      preheader: 'Tap to confirm your subscription to the TuruLav newsletter.',
      heading: 'Confirm your subscription',
      body: `Thanks for signing up to the <strong style="color:#f43f5e;">TuruLav</strong> newsletter. Confirm your email below and you're in.`,
      ctaLabel: 'Confirm subscription',
      ctaUrl: confirmUrl,
      fineprint: `This link expires in 7 days. If you didn't request this, you can safely ignore this email — you won't be subscribed.`,
    });
    await this.send({ to: email, subject, html, text });
  }

  private withUnsubscribeFooter(html: string, unsubscribeUrl: string): string {
    return html.replace(
      '<a href="' + BRAND_HOME + '/privacy"',
      `<a href="${unsubscribeUrl}" style="color:#a99a90; text-decoration:underline;">Unsubscribe</a>\n                  &nbsp;&middot;&nbsp;\n                  <a href="${BRAND_HOME}/privacy"`,
    );
  }

  async sendNewsletterWelcomeForGuest(email: string, unsubscribeToken: string): Promise<void> {
    const unsubscribeUrl = `${this.baseUrl}/newsletter/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`;
    const subject = 'Welcome to TuruLav';
    const text =
      `Welcome to TuruLav!\n\n` +
      `You're now on the newsletter list — you'll get updates straight to your inbox.\n\n` +
      `Looking for love along the way? Create your account here: ${BRAND_HOME}\n\n` +
      `Changed your mind? Unsubscribe any time:\n${unsubscribeUrl}`;
    const html = this.shell({
      preheader: 'Welcome to TuruLav — you’re on the list.',
      heading: 'Welcome to TuruLav',
      body: `You're now subscribed to the <strong style="color:#f43f5e;">TuruLav</strong> newsletter. We'll keep you posted on what's new — and if you ever want in on the dating side, your account is just a click away.`,
      ctaLabel: 'Create your account',
      ctaUrl: BRAND_HOME,
      fineprint: `Not ready to sign up yet? No problem — you'll still get the newsletter. Unsubscribe below at any time.`,
    });
    await this.send({
      to: email,
      subject,
      html: this.withUnsubscribeFooter(html, unsubscribeUrl),
      text,
    });
  }

  async sendNewsletterWelcomeForUser(email: string, unsubscribeToken: string): Promise<void> {
    const unsubscribeUrl = `${this.baseUrl}/newsletter/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`;
    const subject = "You're on the TuruLav newsletter list";
    const text =
      `Thanks for opting in.\n\n` +
      `You'll get TuruLav updates straight to your inbox, alongside everything happening in the app.\n\n` +
      `Want fewer emails? Manage your preferences in account settings, or unsubscribe here:\n${unsubscribeUrl}`;
    const html = this.shell({
      preheader: "You're on the list — thanks for opting in.",
      heading: "You're on the list",
      body: `Thanks for opting in. As a <strong style="color:#f43f5e;">TuruLav</strong> member, you'll get our newsletter alongside everything happening in the app — new features, community stories, and the occasional love letter from the team.`,
      ctaLabel: 'Open TuruLav',
      ctaUrl: BRAND_HOME,
      fineprint: `Want fewer emails? Manage preferences from your account settings, or unsubscribe below.`,
    });
    await this.send({
      to: email,
      subject,
      html: this.withUnsubscribeFooter(html, unsubscribeUrl),
      text,
    });
  }
}
