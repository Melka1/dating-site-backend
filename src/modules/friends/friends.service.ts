import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, MoreThan, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { FriendCard } from './dto/friend-card.dto';
import { ListFriendsDto } from './dto/list-friends.dto';
import { ListRequestsDto } from './dto/list-requests.dto';
import { MatchSuggestion } from './dto/match-suggestions.dto';
import { SendFriendRequestDto } from './dto/send-friend-request.dto';
import { Friendship, FriendshipStatus } from './entities/friendship.entity';
import { UserBlock } from './entities/user-block.entity';

const MAX_OUTSTANDING_PENDING = 50;
const MAX_REQUESTS_PER_24H = 100;

export type FriendshipPairStatus =
  | 'none'
  | 'pending_in'
  | 'pending_out'
  | 'accepted'
  | 'blocked_by_me'
  | 'blocked_by_them';

export interface SortedPair {
  userLow: string;
  userHigh: string;
}

@Injectable()
export class FriendsService {
  constructor(
    @InjectRepository(Friendship) private readonly friendships: Repository<Friendship>,
    @InjectRepository(UserBlock) private readonly blocks: Repository<UserBlock>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectDataSource() private readonly ds: DataSource,
  ) {}

  // ---------------------------------------------------------------------------
  // Request lifecycle
  // ---------------------------------------------------------------------------

  async sendRequest(actorId: string, dto: SendFriendRequestDto): Promise<Friendship> {
    if (actorId === dto.targetUserId) {
      throw new BadRequestException('You cannot friend yourself');
    }
    const target = await this.users.findOne({
      where: { id: dto.targetUserId },
      select: ['id', 'accountStatus'],
    });
    if (!target || target.accountStatus !== 'active') {
      throw new NotFoundException('User not found');
    }

    const pair = sortPair(actorId, dto.targetUserId);

    const existingBlock = await this.blocks.findOne({
      where: [
        { blockerId: pair.userLow, blockedId: pair.userHigh },
        { blockerId: pair.userHigh, blockedId: pair.userLow },
      ],
      select: ['blockerId'],
    });
    if (existingBlock) {
      throw new ConflictException({ code: 'BLOCKED', message: 'Cannot send a friend request' });
    }

    const existing = await this.friendships.findOne({ where: pair });
    if (existing) {
      throw new ConflictException({
        code: existing.status === 'accepted' ? 'ALREADY_FRIENDS' : 'REQUEST_EXISTS',
        message:
          existing.status === 'accepted'
            ? 'You are already friends'
            : 'A friend request already exists between these users',
      });
    }

    await this.assertRateLimit(actorId);

    const row = this.friendships.create({
      userLow: pair.userLow,
      userHigh: pair.userHigh,
      requestedBy: actorId,
      status: FriendshipStatus.PENDING,
      message: dto.message?.trim() || null,
    });
    return this.friendships.save(row);
  }

  async acceptRequest(actorId: string, requestId: string): Promise<Friendship> {
    const pair = parseRequestId(requestId, actorId);
    return this.ds.transaction(async (m) => {
      const row = await m.getRepository(Friendship).findOne({ where: pair });
      if (!row || row.status !== FriendshipStatus.PENDING) {
        throw new NotFoundException('No pending request');
      }
      if (row.requestedBy === actorId) {
        throw new ForbiddenException('The sender cannot accept their own request');
      }
      if (actorId !== row.userLow && actorId !== row.userHigh) {
        throw new ForbiddenException('Not your request');
      }
      row.status = FriendshipStatus.ACCEPTED;
      // accepted_at is stamped by the friendships_accepted_stamp trigger.
      await m.getRepository(Friendship).save(row);
      return row;
    });
  }

  async declineRequest(actorId: string, requestId: string): Promise<void> {
    const pair = parseRequestId(requestId, actorId);
    const row = await this.friendships.findOne({ where: pair });
    if (!row || row.status !== FriendshipStatus.PENDING) {
      throw new NotFoundException('No pending request');
    }
    if (row.requestedBy === actorId) {
      throw new ForbiddenException('Use cancel to revoke your own outgoing request');
    }
    if (actorId !== row.userLow && actorId !== row.userHigh) {
      throw new ForbiddenException('Not your request');
    }
    await this.friendships.delete(pair);
  }

  async cancelRequest(actorId: string, requestId: string): Promise<void> {
    const pair = parseRequestId(requestId, actorId);
    const row = await this.friendships.findOne({ where: pair });
    if (!row || row.status !== FriendshipStatus.PENDING) {
      throw new NotFoundException('No pending request');
    }
    if (row.requestedBy !== actorId) {
      throw new ForbiddenException('Only the sender can cancel an outgoing request');
    }
    await this.friendships.delete(pair);
  }

  async listIncoming(
    actorId: string,
    query: ListRequestsDto,
  ): Promise<{ items: Friendship[]; total: number; page: number; limit: number }> {
    const qb = this.friendships
      .createQueryBuilder('f')
      .where('f.status = :status', { status: FriendshipStatus.PENDING })
      .andWhere('(f.user_low = :me OR f.user_high = :me)', { me: actorId })
      .andWhere('f.requested_by <> :me', { me: actorId })
      .orderBy('f.createdAt', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit);
    const [items, total] = await qb.getManyAndCount();
    return { items, total, page: query.page, limit: query.limit };
  }

  async listOutgoing(
    actorId: string,
    query: ListRequestsDto,
  ): Promise<{ items: Friendship[]; total: number; page: number; limit: number }> {
    const qb = this.friendships
      .createQueryBuilder('f')
      .where('f.status = :status', { status: FriendshipStatus.PENDING })
      .andWhere('f.requested_by = :me', { me: actorId })
      .orderBy('f.createdAt', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit);
    const [items, total] = await qb.getManyAndCount();
    return { items, total, page: query.page, limit: query.limit };
  }

  // ---------------------------------------------------------------------------
  // Friends list / status / unfriend
  // ---------------------------------------------------------------------------

  async listFriends(
    actorId: string,
    query: ListFriendsDto,
  ): Promise<{ items: FriendCard[]; total: number; page: number; limit: number }> {
    const qb = this.users
      .createQueryBuilder('u')
      .select('u.id', 'id')
      .addSelect('u.username', 'username')
      .addSelect('u.isOnline', 'isOnline')
      .addSelect('u.lastActiveAt', 'lastActiveAt')
      .addSelect('u.friendCount', 'friendCount')
      .addSelect('p.display_name', 'displayName')
      .addSelect('p.avatar_url', 'avatarUrl')
      .addSelect('p.gender', 'gender')
      .addSelect('p.dob', 'dob')
      .addSelect('p.country', 'country')
      .addSelect('p.city', 'city')
      .addSelect('p.bio', 'bio')
      .innerJoin(
        'friendships',
        'f',
        `f.status = 'accepted'
         AND ((f.user_low = :me AND f.user_high = u.id) OR (f.user_high = :me AND f.user_low = u.id))`,
        { me: actorId },
      )
      .leftJoin('profiles', 'p', 'p.user_id = u.id')
      .where('u.account_status = :active', { active: 'active' });

    if (query.q) {
      qb.andWhere('u.username ILIKE :q', { q: `%${query.q}%` });
    }
    if (query.country) {
      qb.andWhere('p.country = :country', { country: query.country });
    }

    if (query.sort === 'name') {
      qb.orderBy('u.username', 'ASC');
    } else {
      qb.orderBy('f.accepted_at', 'DESC');
    }

    const total = await qb.getCount();
    const items = await qb
      .limit(query.limit)
      .offset((query.page - 1) * query.limit)
      .getRawMany<FriendCard>();

    return { items, total, page: query.page, limit: query.limit };
  }

  async getStatus(actorId: string, otherUserId: string): Promise<{ status: FriendshipPairStatus }> {
    if (actorId === otherUserId) {
      return { status: 'none' };
    }
    const blockByMe = await this.blocks.findOne({
      where: { blockerId: actorId, blockedId: otherUserId },
      select: ['blockerId'],
    });
    if (blockByMe) return { status: 'blocked_by_me' };

    const blockByThem = await this.blocks.findOne({
      where: { blockerId: otherUserId, blockedId: actorId },
      select: ['blockerId'],
    });
    if (blockByThem) return { status: 'blocked_by_them' };

    const pair = sortPair(actorId, otherUserId);
    const row = await this.friendships.findOne({ where: pair });
    if (!row) return { status: 'none' };
    if (row.status === FriendshipStatus.ACCEPTED) return { status: 'accepted' };
    return { status: row.requestedBy === actorId ? 'pending_out' : 'pending_in' };
  }

  async unfriend(actorId: string, otherUserId: string): Promise<void> {
    const pair = sortPair(actorId, otherUserId);
    const row = await this.friendships.findOne({ where: pair });
    if (!row || row.status !== FriendshipStatus.ACCEPTED) {
      throw new NotFoundException('Not friends');
    }
    await this.friendships.delete(pair);
  }

  // ---------------------------------------------------------------------------
  // Discovery — mutuals + suggestions
  // ---------------------------------------------------------------------------

  async mutualFriends(
    actorId: string,
    otherUserId: string,
    query: ListRequestsDto,
  ): Promise<{ items: User[]; total: number; page: number; limit: number }> {
    if (actorId === otherUserId) {
      return { items: [], total: 0, page: query.page, limit: query.limit };
    }
    const params = {
      me: actorId,
      them: otherUserId,
      active: 'active',
      limit: query.limit,
      offset: (query.page - 1) * query.limit,
    };

    const rows: Array<{ id: string }> = await this.ds.query(
      `
      with me as (
        select case when user_low = $1 then user_high else user_low end as friend_id
        from public.friendships
        where status = 'accepted' and (user_low = $1 or user_high = $1)
      ),
      them as (
        select case when user_low = $2 then user_high else user_low end as friend_id
        from public.friendships
        where status = 'accepted' and (user_low = $2 or user_high = $2)
      ),
      shared as (
        select friend_id from me intersect select friend_id from them
      )
      select u.id
        from shared
        join public.users u on u.id = shared.friend_id
       where u.account_status = $3
       order by u.username asc
       limit $4 offset $5
      `,
      [params.me, params.them, params.active, params.limit, params.offset],
    );

    const totalRow: Array<{ count: string }> = await this.ds.query(
      `
      with me as (
        select case when user_low = $1 then user_high else user_low end as friend_id
        from public.friendships
        where status = 'accepted' and (user_low = $1 or user_high = $1)
      ),
      them as (
        select case when user_low = $2 then user_high else user_low end as friend_id
        from public.friendships
        where status = 'accepted' and (user_low = $2 or user_high = $2)
      ),
      shared as (
        select friend_id from me intersect select friend_id from them
      )
      select count(*)::text as count
        from shared
        join public.users u on u.id = shared.friend_id
       where u.account_status = $3
      `,
      [params.me, params.them, params.active],
    );

    if (rows.length === 0) {
      return { items: [], total: Number(totalRow[0]?.count ?? 0), page: query.page, limit: query.limit };
    }
    const ids = rows.map((r) => r.id);
    const users = await this.users.findBy({ id: In(ids) });
    // preserve order from the SQL
    const byId = new Map(users.map((u) => [u.id, u]));
    const items = ids.map((id) => byId.get(id)!).filter(Boolean);
    return {
      items,
      total: Number(totalRow[0]?.count ?? items.length),
      page: query.page,
      limit: query.limit,
    };
  }

  async matchSuggestions(actorId: string, limit = 20): Promise<MatchSuggestion[]> {
    const myProfile = await this.ds.query(
      `select 1 from public.profiles where user_id = $1 limit 1`,
      [actorId],
    );
    if (!myProfile || myProfile.length === 0) return [];

    const rows: Array<MatchSuggestion & { score: string | number }> = await this.ds.query(
      `
      with mp as (
        select gender, seeking, interests, languages, country, city, religion, relationship_type, dob
        from public.profiles where user_id = $1
      ),
      my_known as (
        select case when user_low = $1 then user_high else user_low end as other_id
        from public.friendships where user_low = $1 or user_high = $1
      ),
      my_blocks as (
        select blocked_id as other_id from public.user_blocks where blocker_id = $1
        union
        select blocker_id as other_id from public.user_blocks where blocked_id = $1
      ),
      scored as (
        select
          u.id,
          u.username,
          u.is_online as "isOnline",
          u.last_active_at as "lastActiveAt",
          u.friend_count as "friendCount",
          p.display_name as "displayName",
          p.avatar_url as "avatarUrl",
          p.gender,
          p.dob,
          p.country,
          p.city,
          p.bio,
          (select count(*)::int
             from unnest(coalesce(p.interests, '{}'::text[])) x
            where x = any(coalesce(mp.interests, '{}'::text[]))
          ) as "sharedInterests",
          (select count(*)::int
             from unnest(coalesce(p.languages, '{}'::text[])) x
            where x = any(coalesce(mp.languages, '{}'::text[]))
          ) as "sharedLanguages",
          (case when p.country is not null and p.country = mp.country then 1 else 0 end) as "sameCountry",
          (case when p.city is not null and p.city = mp.city then 1 else 0 end) as "sameCity",
          (case when p.religion is not null and p.religion = mp.religion then 1 else 0 end) as "sameReligion",
          (case when p.relationship_type is not null and p.relationship_type = mp.relationship_type then 1 else 0 end) as "sameRelationshipType"
        from public.users u
        join public.profiles p on p.user_id = u.id
        cross join mp
        where u.account_status = 'active'
          and u.id <> $1
          and u.id not in (select other_id from my_known)
          and u.id not in (select other_id from my_blocks)
          and (cardinality(coalesce(mp.seeking, '{}'::text[])) = 0 or p.gender = any(mp.seeking))
      )
      select
        id, username, "isOnline", "lastActiveAt", "friendCount",
        "displayName", "avatarUrl", gender, dob, country, city, bio,
        "sharedInterests", "sharedLanguages",
        "sameCountry", "sameCity", "sameReligion", "sameRelationshipType",
        ("sharedInterests" * 3 + "sharedLanguages" * 2 + "sameCountry" * 2 + "sameCity" * 3
          + "sameReligion" + "sameRelationshipType") as score
      from scored
      where ("sharedInterests" + "sharedLanguages" + "sameCountry" + "sameCity"
             + "sameReligion" + "sameRelationshipType") > 0
      order by score desc, "lastActiveAt" desc nulls last
      limit $2
      `,
      [actorId, limit],
    );

    return rows.map((r) => ({ ...r, score: Number(r.score) }));
  }

  async suggestFriends(actorId: string, limit = 20): Promise<Array<FriendCard & { mutuals: number }>> {
    const rows: Array<FriendCard & { mutuals: string | number }> = await this.ds.query(
      `
      with my_friends as (
        select case when user_low = $1 then user_high else user_low end as friend_id
        from public.friendships
        where status = 'accepted' and (user_low = $1 or user_high = $1)
      ),
      my_known as (
        select case when user_low = $1 then user_high else user_low end as other_id
        from public.friendships
        where user_low = $1 or user_high = $1
      ),
      my_blocks as (
        select blocked_id as other_id from public.user_blocks where blocker_id = $1
        union
        select blocker_id from public.user_blocks where blocked_id = $1
      ),
      fof as (
        select case when f.user_low = mf.friend_id then f.user_high else f.user_low end as candidate_id
        from my_friends mf
        join public.friendships f
          on f.status = 'accepted'
         and (f.user_low = mf.friend_id or f.user_high = mf.friend_id)
      ),
      scored as (
        select candidate_id, count(*)::int as mutuals
        from fof
        where candidate_id <> $1
          and candidate_id not in (select friend_id from my_friends)
          and candidate_id not in (select other_id from my_known)
          and candidate_id not in (select other_id from my_blocks)
        group by candidate_id
      )
      select
        u.id,
        u.username,
        u.is_online as "isOnline",
        u.last_active_at as "lastActiveAt",
        u.friend_count as "friendCount",
        p.display_name as "displayName",
        p.avatar_url as "avatarUrl",
        p.gender,
        p.dob,
        p.country,
        p.city,
        p.bio,
        s.mutuals
        from scored s
        join public.users u on u.id = s.candidate_id
        left join public.profiles p on p.user_id = u.id
       where u.account_status = 'active'
       order by s.mutuals desc, u.last_active_at desc nulls last
       limit $2
      `,
      [actorId, limit],
    );
    return rows.map((r) => ({ ...r, mutuals: Number(r.mutuals) }));
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async assertRateLimit(actorId: string): Promise<void> {
    const outstanding = await this.friendships.count({
      where: { requestedBy: actorId, status: FriendshipStatus.PENDING },
    });
    if (outstanding >= MAX_OUTSTANDING_PENDING) {
      throw new HttpException(
        { code: 'RATE_LIMITED', message: 'Too many outstanding friend requests' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await this.friendships.count({
      where: { requestedBy: actorId, createdAt: MoreThan(since) },
    });
    if (recent >= MAX_REQUESTS_PER_24H) {
      throw new HttpException(
        { code: 'RATE_LIMITED', message: 'Daily friend-request limit reached' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

export function sortPair(a: string, b: string): SortedPair {
  return a < b ? { userLow: a, userHigh: b } : { userLow: b, userHigh: a };
}

/**
 * Accepts either "<userLow>:<userHigh>" or the partner's userId. In the latter
 * case the caller's userId is paired with it and sorted canonically.
 */
export function parseRequestId(idOrPartnerId: string, actorId: string): SortedPair {
  if (idOrPartnerId.includes(':')) {
    const [a, b] = idOrPartnerId.split(':');
    if (!a || !b || a >= b) throw new BadRequestException('Invalid request id');
    return { userLow: a, userHigh: b };
  }
  if (idOrPartnerId === actorId) {
    throw new BadRequestException('Invalid request id');
  }
  return sortPair(actorId, idOrPartnerId);
}
