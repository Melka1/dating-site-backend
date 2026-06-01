import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Viewer } from '../../common/viewer';
import { Profile } from '../profiles/entities/profile.entity';
import { AccountStatus, User } from '../users/entities/user.entity';

export interface StatsResponse {
  totalMembers: number;
  totalOnline: number;
  menOnline: number;
  womenOnline: number;
  preferredGenderOnline: number | null;
  sameProfessionOnline: number | null;
}

interface AggregateRow {
  total_members: string;
  total_online: string;
  men_online: string;
  women_online: string;
  preferred_gender_online: string | null;
  same_profession_online: string | null;
}

@Injectable()
export class StatsService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
  ) {}

  async getStats(viewer: Viewer): Promise<StatsResponse> {
    const personalized = viewer.userId
      ? await this.profiles.findOne({
          where: { userId: viewer.userId },
          select: ['userId', 'seeking', 'profession'],
        })
      : null;

    const seeking = personalized?.seeking?.length ? personalized.seeking : null;
    const profession = personalized?.profession ?? null;

    const qb = this.users
      .createQueryBuilder('u')
      .leftJoin(Profile, 'p', 'p.user_id = u.id')
      .select(
        `COUNT(*) FILTER (WHERE u.account_status = :active)`,
        'total_members',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE u.account_status = :active AND u.is_online = true)`,
        'total_online',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE u.account_status = :active AND u.is_online = true AND p.gender = 'male')`,
        'men_online',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE u.account_status = :active AND u.is_online = true AND p.gender = 'female')`,
        'women_online',
      );

    if (seeking) {
      qb.addSelect(
        `COUNT(*) FILTER (WHERE u.account_status = :active AND u.is_online = true AND p.gender = ANY(:seeking::text[]))`,
        'preferred_gender_online',
      );
    } else {
      qb.addSelect(`NULL::bigint`, 'preferred_gender_online');
    }

    if (profession) {
      const professionFilter = seeking
        ? `COUNT(*) FILTER (WHERE u.account_status = :active AND u.is_online = true AND p.profession = :profession AND p.gender = ANY(:seeking::text[]))`
        : `COUNT(*) FILTER (WHERE u.account_status = :active AND u.is_online = true AND p.profession = :profession)`;
      qb.addSelect(professionFilter, 'same_profession_online');
    } else {
      qb.addSelect(`NULL::bigint`, 'same_profession_online');
    }

    qb.setParameter('active', AccountStatus.ACTIVE);
    if (seeking) qb.setParameter('seeking', seeking);
    if (profession) qb.setParameter('profession', profession);

    if (viewer.userId) {
      qb.where('u.id <> :viewerId', { viewerId: viewer.userId });
    }

    const row = await qb.getRawOne<AggregateRow>();

    return {
      totalMembers: toInt(row?.total_members),
      totalOnline: toInt(row?.total_online),
      menOnline: toInt(row?.men_online),
      womenOnline: toInt(row?.women_online),
      preferredGenderOnline: seeking ? toInt(row?.preferred_gender_online) : null,
      sameProfessionOnline: profession ? toInt(row?.same_profession_online) : null,
    };
  }
}

function toInt(v: string | null | undefined): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
