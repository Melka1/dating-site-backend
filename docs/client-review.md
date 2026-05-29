# Dating site — progress review

**Date:** 2026-05-18

A plain-English summary of what's built and what's left.

---

## ✅ Done

### Accounts
- Sign up, log in, log out, email verification
- Delete account (60-day grace, then permanent wipe)
- Restore a deleted account within the grace period
- Banned / deleted accounts blocked from logging in

### Profiles
- All standard dating fields: gender, seeking, relationship type, bio, interests, languages, religion, age (18+ enforced), height, weight, body type, ethnicity, profession, country, city
- Profile photo + cover photo upload
- Visibility: public / members-only / private
- Online status + last-active time
- Auto-calculated profile completion %

### Browse & search
- Search members by gender, seeking, interests, country, age range, profession
- Sort by newest, most active, most popular
- Typo-tolerant name search

### Friends
- Send / accept / decline / cancel friend requests
- Friends list with search and filters
- Mutual friends
- Friend suggestions (friends-of-friends + shared interests + location)
- Spam protection on outgoing requests

### Blocking
- Block / unblock a user
- Blocking auto-cancels any existing friendship and pending requests

### Groups
- Create groups (public / unlisted / private)
- Join policies: open, request-and-approve, invite-only
- Roles: owner / admin / member, with ownership transfer
- Invite, approve, kick, ban, unban
- Search and browse groups by name, interests, country
- Group avatar + cover photo

### Posts & engagement
- Post text + up to 10 photos/videos
- Visibility per post: everyone / friends only / specific group
- Tag people with `@username`
- Reactions, comments, nested replies
- Save posts to favorites
- Activity feed with 5 views (personal, mentions, favorites, friends, groups)
- Sort by most recent or most popular

### Admin tools
- Manage users (suspend, unsuspend, ban, change role)
- Manage groups (suspend, force-delete)
- Manage friendships (force-remove, audit)
- Full audit log of every admin action

### Safety & reliability
- Two-layer access control (app + database both enforce permissions)
- Rate limits against scraping and brute-force
- Nightly automatic cleanup of items past their 60-day grace period
- Error tracking with unique IDs

### Guest browsing — partial
- Logged-out visitors can browse public profiles and search members

---

## ❌ Still to build

### 1. Chat / direct messages
- One-on-one conversations
- Real-time delivery, typing indicators, online presence
- Read receipts, unread counts
- Photo / video / voice attachments
- Block integration
- Spam controls and reporting

### 2. Notifications
- In-app notification list
- Push notifications to mobile
- Email notifications with user preferences
- Triggers: friend requests, mentions, reactions, group invites, etc.

### 3. Dating features
- Like / pass interaction
- Mutual matches
- Discovery feed (compatibility-scored recommendations)
- Filters: age range, distance, gender, seeking
- "Who viewed your profile"
- Optional: distance / radius search

### 4. Reports & moderation
- Users can report a profile, post, comment, or group
- Admin queue to triage and act on reports

### 5. Email delivery
- Connect an email provider (currently no emails are actually sent)
- Restore-account links, verification, notifications, grace-period reminders

### 6. Finish guest browsing
- Public posts readable while logged out
- Public groups browsable while logged out

### 7. Pre-launch polish
- Profanity / safety filter on usernames, bios, posts
- Stricter rate limits on login
- Translation support (if launching in multiple languages)
- Automated end-to-end tests
- Continuous-integration pipeline

---

## Recommended build order

1. **Email provider** — small task, unblocks several existing features
2. **Notifications** — turns existing actions into things users feel
3. **Reports & moderation** — must be in place before public launch
4. **Chat / messaging** — biggest remaining piece
5. **Dating features (like / match / discovery)** — turns the platform from a social network into a true dating site
6. **Guest browsing finish + tests + polish** — final pre-launch pass

---

## At-a-glance status

| Feature | Status |
|---|---|
| Sign up, login, email verify | ✅ |
| Profiles + photos | ✅ |
| Member search | ✅ |
| Friends & blocking | ✅ |
| Groups | ✅ |
| Posts, comments, reactions, favorites | ✅ |
| Activity feed | ✅ |
| Admin tools | ✅ |
| Direct messages / chat | ❌ |
| Notifications | ❌ |
| Like / match / dating discovery | ❌ |
| Reports & moderation | ❌ |
| Email delivery | ❌ |
| Guest browsing | ⚠️ partial |
