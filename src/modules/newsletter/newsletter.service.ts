import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AppConfig } from '../../config/configuration';
import { MailService } from '../mail/mail.service';
import {
  NewsletterSource,
  NewsletterStatus,
  NewsletterSubscriber,
} from './entities/newsletter-subscriber.entity';

interface ConfirmTokenPayload {
  email: string;
  purpose: 'newsletter_confirm';
}

interface UnsubscribeTokenPayload {
  email: string;
  purpose: 'newsletter_unsubscribe';
}

export interface SubscribeResult {
  status: NewsletterStatus;
  email: string;
}

@Injectable()
export class NewsletterService {
  constructor(
    @InjectRepository(NewsletterSubscriber)
    private readonly subs: Repository<NewsletterSubscriber>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly mail: MailService,
  ) {}

  async subscribeAuthenticated(userId: string, authEmail: string): Promise<SubscribeResult> {
    const email = authEmail.trim().toLowerCase();
    const now = new Date();

    const existing = await this.subs.findOne({ where: { email } });
    if (existing?.status === NewsletterStatus.ACTIVE) {
      return { status: existing.status, email };
    }

    await this.subs.save({
      ...(existing ?? {}),
      email,
      userId,
      status: NewsletterStatus.ACTIVE,
      source: existing?.source ?? NewsletterSource.AUTHENTICATED,
      subscribedAt: existing?.subscribedAt ?? now,
      unsubscribedAt: null,
    });

    const unsubscribeToken = await this.signUnsubscribeToken(email);
    await this.mail.sendNewsletterWelcomeForUser(email, unsubscribeToken);

    return { status: NewsletterStatus.ACTIVE, email };
  }

  async subscribeGuest(rawEmail: string): Promise<SubscribeResult> {
    const email = rawEmail.trim().toLowerCase();
    const now = new Date();

    const existing = await this.subs.findOne({ where: { email } });
    if (existing?.status === NewsletterStatus.ACTIVE) {
      return { status: existing.status, email };
    }

    await this.subs.save({
      ...(existing ?? {}),
      email,
      userId: existing?.userId ?? null,
      status: NewsletterStatus.PENDING,
      source: existing?.source ?? NewsletterSource.GUEST_FORM,
      confirmationSentAt: now,
      unsubscribedAt: null,
    });

    const token = await this.jwt.signAsync(
      { email, purpose: 'newsletter_confirm' } satisfies ConfirmTokenPayload,
      {
        secret: this.config.get('jwt.restoreSecret', { infer: true }),
        expiresIn: '7d',
      },
    );
    await this.mail.sendNewsletterConfirmation(email, token);

    return { status: NewsletterStatus.PENDING, email };
  }

  async confirm(token: string): Promise<{ email: string }> {
    let payload: ConfirmTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<ConfirmTokenPayload>(token, {
        secret: this.config.get('jwt.restoreSecret', { infer: true }),
      });
    } catch {
      throw new BadRequestException('Invalid or expired confirmation token');
    }
    if (payload.purpose !== 'newsletter_confirm' || !payload.email) {
      throw new BadRequestException('Invalid confirmation token');
    }

    const email = payload.email.trim().toLowerCase();
    const row = await this.subs.findOne({ where: { email } });
    if (!row) throw new NotFoundException('Subscriber not found');

    if (row.status === NewsletterStatus.ACTIVE) return { email };

    await this.subs.update(
      { email },
      {
        status: NewsletterStatus.ACTIVE,
        subscribedAt: row.subscribedAt ?? new Date(),
        unsubscribedAt: null,
      },
    );

    const unsubscribeToken = await this.signUnsubscribeToken(email);
    await this.mail.sendNewsletterWelcomeForGuest(email, unsubscribeToken);

    return { email };
  }

  async unsubscribe(token: string): Promise<{ email: string }> {
    let payload: UnsubscribeTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<UnsubscribeTokenPayload>(token, {
        secret: this.config.get('jwt.restoreSecret', { infer: true }),
      });
    } catch {
      throw new BadRequestException('Invalid or expired unsubscribe token');
    }
    if (payload.purpose !== 'newsletter_unsubscribe' || !payload.email) {
      throw new BadRequestException('Invalid unsubscribe token');
    }

    const email = payload.email.trim().toLowerCase();
    const row = await this.subs.findOne({ where: { email } });
    if (!row) throw new NotFoundException('Subscriber not found');

    await this.subs.update(
      { email },
      { status: NewsletterStatus.UNSUBSCRIBED, unsubscribedAt: new Date() },
    );
    return { email };
  }

  async signUnsubscribeToken(email: string): Promise<string> {
    return this.jwt.signAsync(
      {
        email: email.trim().toLowerCase(),
        purpose: 'newsletter_unsubscribe',
      } satisfies UnsubscribeTokenPayload,
      {
        secret: this.config.get('jwt.restoreSecret', { infer: true }),
        expiresIn: '365d',
      },
    );
  }
}
