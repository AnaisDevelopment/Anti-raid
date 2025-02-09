import type { Action } from '@types'
import {
    Guild as BaseGuild,
    GuildAuditLogsActions,
    GuildAuditLogsActionType,
    GuildAuditLogsEntry,
    Role,
    Snowflake,
    User
} from 'discord.js'
import config from '../config'
import { BAD_PERMISSIONS, IGNORED_IDS, LIMITS, TRUSTED_BOTS } from '../Constants'
import { ActionManager } from '../structures'
import ms from 'ms'

class Guild extends BaseGuild {
    get actions(): ActionManager {
        return ActionManager.get(this.id)
    }

    get owner() {
        return this.members.cache.get(this.ownerId) ?? null
    }

    async punish(userId: Snowflake): Promise<void> {
        if (this.isCIA(userId)) return

        const promises: Promise<unknown>[] = []
        const roles: Role[] = []

        const muteRole = this.roles.cache.find((role) => role.name === 'Muted')
        const botRole = this.roles.botRoleFor(userId)

        if (muteRole) roles.push(muteRole)
        if (botRole) roles.push(botRole)

        promises.push(this.members.edit(userId, { roles }))

        if (botRole) {
            promises.push(botRole.setPermissions(botRole.permissions.remove(BAD_PERMISSIONS)))
        }

        for (const channel of this.channels.cache.values()) {
            if (channel.isThread()) continue
            for (const [id, overwrite] of channel.permissionOverwrites.cache) {
                if (id === userId && overwrite.allow.any(BAD_PERMISSIONS)) promises.push(overwrite.delete())
            }
        }

        await Promise.allSettled(promises)
    }

    private async _checkUser(user: User, entry: GuildAuditLogsEntry): Promise<boolean> {
        const action: Action = {
            id: entry.id,
            executorId: user.id,
            timestamp: entry.createdTimestamp,
            type: entry.actionType
        }

        const db = this.actions.add(action)

        if (this.isIgnored(action.executorId) || this.running.has(action.executorId)) return false

        const now = Date.now()
        const limited =
            db.filter(({ type, timestamp }) => {
                return type === action.type && now - timestamp <= config.INTERAVL
            }).size >= LIMITS[action.type]

        if (!limited) return false

        this.owner?.dm(`**${user.tag}** (ID: \`${user.id}\`) is limited!!\nType: \`${action.type}\``)

        this.running.add(user.id)

        await this.punish(user.id)

        this.running.delete(user.id)

        return true
    }

    private async _checkGlobal(type: GuildAuditLogsActionType): Promise<void> {
        if (this.running.has('GLOBAL')) return

        const now = Date.now()
        const limited = this.actions
            .flat()
            .filter((action) => action.type === type && now - action.timestamp <= LIMITS.GLOBAL.TIME)

        if (!(limited.length >= LIMITS.GLOBAL.MAX)) return

        this.running.add('GLOBAL')

        this.owner?.dm('**WARNING: GLOBAL RATE LIMIT WAKE UP!!**', { times: 5 })

        const promises: Promise<unknown>[] = []

        for (const { executorId } of limited) {
            if (this.isIgnored(executorId)) {
                promises.push(this.punish(executorId))
            } else {
                promises.push(this.bans.create(executorId))
            }
        }

        promises.push(this.cleanup('roles'))
        promises.push(this.cleanup('channels'))

        await Promise.allSettled(promises.flat())

        if (this.verificationLevel !== 'VERY_HIGH') {
            await this.setVerificationLevel('VERY_HIGH').catch(() => null)
        }

        this.running.delete('GLOBAL')
    }

    cleanup(type: 'channels' | 'roles' | 'bots') {
        const promises: Promise<unknown>[] = []

        switch (type) {
            case 'channels':
                for (const channel of this.channels.cache.values()) {
                    if (channel.isThread()) continue
                    for (const [id, overwrite] of channel.permissionOverwrites.cache) {
                        if (!TRUSTED_BOTS.has(id) && overwrite.allow.any(BAD_PERMISSIONS)) {
                            promises.push(overwrite.delete())
                        }
                    }
                }
                break
            case 'roles':
                for (const role of this.roles.cache.values()) {
                    const botId = role.tags?.botId

                    if (botId && TRUSTED_BOTS.has(botId)) continue

                    if (role.permissions.any(BAD_PERMISSIONS)) {
                        promises.push(role.setPermissions(role.permissions.remove(BAD_PERMISSIONS)))
                    }
                }
                break

            case 'bots':
                const time = ms('3h')
                const now = Date.now()

                const bots = this.members.cache.filter((m) => {
                    if (!m.user.bot) return false
                    return now - (m.joinedTimestamp ?? 0) <= time
                })

                for (const [id, bot] of bots) {
                    if (this.isIgnored(id)) continue
                    promises.push(bot.kick())
                }

                break
            default:
                throw new Error('Invalid cleanup type')
        }

        return Promise.allSettled(promises)
    }

    async check(type: keyof GuildAuditLogsActions, targetId?: Snowflake): Promise<void> {
        const entry = await this.fetchEntry(type, targetId),
            user = entry?.executor

        if (!entry || !user) return
        if (this.isCIA(user.id) || TRUSTED_BOTS.has(user.id)) return

        await Promise.all([this._checkUser(user, entry), this._checkGlobal(entry.actionType)])
    }

    async fetchEntry(
        type: keyof GuildAuditLogsActions,
        targetId?: Snowflake,
        isRetry = false
    ): Promise<GuildAuditLogsEntry | null> {
        const entry = await this.fetchAuditLogs({ type, limit: 5 })
            .then(({ entries }) => {
                if (targetId) {
                    return entries.find((e) => (e.target as { id?: Snowflake })?.id === targetId)
                }
                return entries.first()
            })
            .catch(() => null)

        if (!entry && !isRetry) {
            await this.client.sleep(1000)
            return this.fetchEntry(type, targetId, true)
        }

        if (!entry) return null

        if (Date.now() - entry.createdTimestamp > 5000) return null

        return entry
    }

    isCIA(id: Snowflake): boolean {
        return this.client.owners.has(id) || id === this.client.user!.id
    }

    isIgnored(id: Snowflake): boolean {
        return this.isCIA(id) || IGNORED_IDS.includes(id)
    }
}

Object.defineProperties(BaseGuild.prototype, {
    running: {
        value: new Set<'GLOBAL' | Snowflake>()
    }
})

for (const [name, prop] of Object.entries(Object.getOwnPropertyDescriptors(Guild.prototype))) {
    Object.defineProperty(BaseGuild.prototype, name, prop)
}
