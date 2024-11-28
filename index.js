require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ChannelType,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
    ModalBuilder,
    PermissionsBitField,
    ActivityType
} = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Configuration par défaut
const CONFIG = {
    XP_PAR_MESSAGE: 1,
    XP_ACTIONS: {
        WARN: 2,
        MUTE: 3,
        KICK: 5,
        BAN: 10
    },
    COOLDOWN_MESSAGE: 60000 // 1 minute entre chaque gain d'XP par message
};

// Cache pour le cooldown des messages
const messageCooldowns = new Map();

// Cache pour les actions en attente
const pendingActions = new Map();

// Initialiser la base de données SQLite
const db = new sqlite3.Database('bot.db', (err) => {
    if (err) {
        console.error('Erreur lors de la connexion à la base de données:', err);
        return;
    }
    console.log('Connecté à la base de données SQLite');
    
    // Initialiser les tables une seule fois à la connexion
    initDatabase();
});

// Fonction d'initialisation de la base de données
function initDatabase() {
    db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='guild_config'", (err, row) => {
        if (err) {
            console.error('Erreur lors de la vérification des tables:', err);
            return;
        }

        // Si les tables n'existent pas, on les crée
        if (!row) {
            console.log('Création des tables...');
            db.serialize(() => {
                // Table pour les points de mérite
                db.run(`CREATE TABLE IF NOT EXISTS mod_xp (
                    user_id TEXT,
                    guild_id TEXT,
                    xp INTEGER DEFAULT 0,
                    weekly_xp INTEGER DEFAULT 0,
                    PRIMARY KEY (user_id, guild_id)
                )`, err => {
                    if (err) {
                        console.error('Erreur lors de la création de la table mod_xp:', err);
                    } else {
                        console.log('Table mod_xp créée avec succès');
                    }
                });

                // Table pour les actions de modération
                db.run(`CREATE TABLE IF NOT EXISTS mod_actions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT,
                    guild_id TEXT,
                    action_type TEXT,
                    xp_gained INTEGER,
                    week_number INTEGER,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                )`, err => {
                    if (err) {
                        console.error('Erreur lors de la création de la table mod_actions:', err);
                    } else {
                        console.log('Table mod_actions créée avec succès');
                    }
                });

                // Table de configuration
                db.run(`CREATE TABLE IF NOT EXISTS guild_config (
                    guild_id TEXT PRIMARY KEY,
                    mod_role_id TEXT,
                    leaderboard_channel_id TEXT,
                    welcome_channel_id TEXT,
                    welcome_title TEXT,
                    welcome_content TEXT,
                    welcome_image TEXT
                )`, err => {
                    if (err) {
                        console.error('Erreur lors de la création de la table guild_config:', err);
                    } else {
                        console.log('Table guild_config créée avec succès');
                    }
                });
            });
        } else {
            console.log('Les tables existent déjà');
        }
    });
}

// Quand le bot est prêt
client.once('ready', async () => {
    console.log(`${client.user.tag} est prêt !`);
    
    // Liste des statuts à alterner
    const statuts = [
        { name: '☭ Veille sur le Parti', type: ActivityType.Watching },
        { name: '☭ Garde Rouge en service', type: ActivityType.Playing },
        { name: '☭ L\'Internationale', type: ActivityType.Listening },
        { name: '/dashboard', type: ActivityType.Listening }
    ];
    
    let statutIndex = 0;
    
    // Définir le statut initial
    client.user.setPresence({
        activities: [statuts[0]],
        status: 'online'
    });
    
    // Changer le statut toutes les 3 minutes
    setInterval(() => {
        statutIndex = (statutIndex + 1) % statuts.length;
        client.user.setPresence({
            activities: [statuts[statutIndex]],
            status: 'online'
        });
    }, 3 * 60 * 1000);
    
    try {
        // Enregistrer/mettre à jour la commande dashboard
        await client.application.commands.create({
            name: 'dashboard',
            description: '☭ Bureau Politique du Parti ☭'
        });
        console.log('Commande dashboard enregistrée');
    } catch (error) {
        console.error('Erreur lors de l\'enregistrement de la commande:', error);
    }
});

// Fonction pour obtenir le numéro de la semaine
function getWeekNumber() {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 1);
    const diff = now - start;
    const oneWeek = 1000 * 60 * 60 * 24 * 7;
    return Math.floor(diff / oneWeek);
}

// Fonction pour vérifier si un utilisateur est modérateur
async function isModerateur(member) {
    return new Promise((resolve) => {
        db.get('SELECT mod_role_id FROM guild_config WHERE guild_id = ?', 
            [member.guild.id], 
            async (err, row) => {
                if (err || !row || !row.mod_role_id) resolve(false);
                resolve(member.roles.cache.has(row.mod_role_id));
            }
        );
    });
}

// Fonction pour envoyer le leaderboard
async function sendWeeklySummary(guildId) {
    return new Promise((resolve, reject) => {
        db.get('SELECT leaderboard_channel_id FROM guild_config WHERE guild_id = ?', 
            [guildId], 
            async (err, config) => {
                if (err || !config || !config.leaderboard_channel_id) {
                    resolve();
                    return;
                }

                const guild = await client.guilds.fetch(guildId);
                const channel = await guild.channels.fetch(config.leaderboard_channel_id);
                
                if (!channel) {
                    resolve();
                    return;
                }

                db.all(`
                    SELECT 
                        user_id,
                        SUM(weekly_xp) as total_xp
                    FROM mod_xp 
                    WHERE guild_id = ?
                    GROUP BY user_id
                    ORDER BY total_xp DESC
                    LIMIT 10
                `, [guildId], async (err, rows) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    const embed = new EmbedBuilder()
                        .setTitle('☭ Héros de la Modération Hebdomadaire ☭')
                        .setColor('#CC0000')
                        .setDescription('Camarades ! Voici nos plus valeureux défenseurs du prolétariat :')
                        .setTimestamp()
                        .setFooter({ text: 'Le Parti salue votre dévouement !' });

                    for (let i = 0; i < rows.length; i++) {
                        const user = await client.users.fetch(rows[i].user_id);
                        const rank = ['⭐', '🎖️', '🏅', '🌟', '✨'][i] || '•';
                        embed.addFields({
                            name: `${rank} ${user.tag}`,
                            value: `${rows[i].total_xp} Points de Mérite Révolutionnaire`
                        });
                    }

                    await channel.send({ embeds: [embed] });
                    
                    // Réinitialiser les XP hebdomadaires
                    db.run('UPDATE mod_xp SET weekly_xp = 0 WHERE guild_id = ?', [guildId]);
                    
                    resolve();
                });
            }
        );
    });
}

// Planifier l'envoi du leaderboard
cron.schedule('0 0 * * 0', async () => {
    for (const [guildId] of client.guilds.cache) {
        try {
            await sendWeeklySummary(guildId);
        } catch (error) {
            console.error(`Erreur lors de l'envoi du leaderboard pour ${guildId}:`, error);
        }
    }
});

// Gérer les interactions
client.on('interactionCreate', async interaction => {
    if (!interaction.guild) return;

    // Vérifier si c'est un bouton, une commande ou un menu
    if (!interaction.isCommand() && !interaction.isStringSelectMenu() && !interaction.isButton() && !interaction.isModalSubmit()) return;

    // Vérifier les permissions pour la configuration
    if (interaction.customId?.startsWith('config_') || 
        interaction.customId === 'welcome_config' || 
        interaction.customId === 'edit_welcome_message' || 
        interaction.customId === 'edit_welcome_image' ||
        interaction.customId === 'test_welcome' ||
        interaction.customId === 'menu_config') {
        
        // Vérifier si l'utilisateur a les permissions d'administrateur
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            await interaction.reply({ 
                content: '❌ Seuls les administrateurs peuvent configurer le bot !', 
                ephemeral: true 
            });
            return;
        }
    }

    // Vérifier les permissions pour les actions de modération
    if (interaction.customId?.startsWith('mod_')) {
        try {
            const row = await new Promise((resolve, reject) => {
                db.get(
                    'SELECT mod_role_id FROM guild_config WHERE guild_id = ?',
                    [interaction.guildId],
                    (err, row) => {
                        if (err) reject(err);
                        else resolve(row);
                    }
                );
            });

            const modRoleId = row?.mod_role_id;
            
            // Si aucun rôle de modération n'est configuré, autoriser uniquement les administrateurs
            if (!modRoleId) {
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                    await interaction.reply({ 
                        content: '❌ Aucun rôle de modération configuré. Seuls les administrateurs peuvent utiliser ces commandes !', 
                        ephemeral: true 
                    });
                    return;
                }
            } else {
                // Vérifier si l'utilisateur a le rôle de modération ou est administrateur
                if (!interaction.member.roles.cache.has(modRoleId) && 
                    !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                    await interaction.reply({ 
                        content: '❌ Vous n\'avez pas les permissions nécessaires !', 
                        ephemeral: true 
                    });
                    return;
                }
            }
        } catch (error) {
            console.error('Erreur lors de la vérification des permissions:', error);
            await interaction.reply({ 
                content: '❌ Une erreur s\'est produite lors de la vérification des permissions !', 
                ephemeral: true 
            });
            return;
        }
    }

    // Menu principal - Dashboard
    if (interaction.commandName === 'dashboard' || interaction.customId === 'return_dashboard') {
        const mainRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('menu_mod')
                    .setLabel('Justice du Parti')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('⚔️'),
                new ButtonBuilder()
                    .setCustomId('menu_stats')
                    .setLabel('Médailles du Mérite')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('🎖️'),
                new ButtonBuilder()
                    .setCustomId('menu_config')
                    .setLabel('Directives du Parti')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('⚙️')
            );

        const mainEmbed = new EmbedBuilder()
            .setTitle('☭ Bureau Politique du Parti ☭')
            .setDescription(
                'Bienvenue, Camarade ! Le Parti vous salue !\n\n' +
                '⚔️ **Justice du Parti** - Faire respecter la discipline révolutionnaire\n' +
                '🎖️ **Médailles du Mérite** - Honorer les services rendus au Parti\n' +
                '⚙️ **Directives du Parti** - Appliquer la ligne politique'
            )
            .setColor('#CC0000')
            .setFooter({ text: 'Pour la gloire de la Révolution !' });

        try {
            if (interaction.commandName === 'dashboard') {
                await interaction.reply({ embeds: [mainEmbed], components: [mainRow], ephemeral: true });
            } else {
                await interaction.update({ embeds: [mainEmbed], components: [mainRow] });
            }
        } catch (error) {
            console.error('Erreur lors du retour au menu principal:', error);
        }
    }

    // Menu Configuration
    else if (interaction.customId === 'menu_config') {
        db.get(
            'SELECT mod_role_id, leaderboard_channel_id, welcome_channel_id FROM guild_config WHERE guild_id = ?',
            [interaction.guildId],
            async (err, row) => {
                if (err) {
                    console.error('Erreur SQL:', err);
                    return;
                }

                const currentModRole = row?.mod_role_id ? `<@&${row.mod_role_id}>` : 'Non assigné';
                const currentChannel = row?.leaderboard_channel_id ? `<#${row.leaderboard_channel_id}>` : 'Non assigné';
                const welcomeChannel = row?.welcome_channel_id ? `<#${row.welcome_channel_id}>` : 'Non assigné';

                const row1 = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('config_mod_role')
                            .setLabel('Garde Rouge')
                            .setStyle(ButtonStyle.Danger)
                            .setEmoji('👮'),
                        new ButtonBuilder()
                            .setCustomId('config_leaderboard')
                            .setLabel('Canal de Propagande')
                            .setStyle(ButtonStyle.Primary)
                            .setEmoji('📢'),
                        new ButtonBuilder()
                            .setCustomId('config_welcome_channel')
                            .setLabel('Canal d\'Accueil')
                            .setStyle(ButtonStyle.Primary)
                            .setEmoji('🚩'),
                        new ButtonBuilder()
                            .setCustomId('welcome_config')
                            .setLabel('Message d\'Accueil')
                            .setStyle(ButtonStyle.Primary)
                            .setEmoji('📨')
                    );

                const row2 = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('return_dashboard')
                            .setLabel('Retour')
                            .setStyle(ButtonStyle.Secondary)
                            .setEmoji('↩️')
                    );

                const embed = new EmbedBuilder()
                    .setTitle('⚙️ Directives du Parti ⚙️')
                    .setDescription(
                        'Configuration actuelle :\n\n' +
                        `👮 **Garde Rouge** - ${currentModRole}\n` +
                        `📢 **Canal de Propagande** - ${currentChannel}\n` +
                        `🚩 **Canal d'Accueil** - ${welcomeChannel}\n` +
                        '📨 **Message d\'Accueil** - Message de bienvenue révolutionnaire'
                    )
                    .setColor('#CC0000')
                    .setFooter({ text: 'Le Parti guide nos actions !' });

                await interaction.update({ embeds: [embed], components: [row1, row2] });
            }
        );
    }

    // Retour au menu principal
    else if (interaction.customId === 'return_dashboard') {
        try {
            const mainEmbed = new EmbedBuilder()
                .setTitle('☭ Bureau Politique du Parti ☭')
                .setDescription(
                    'Bienvenue au Bureau Politique, Camarade.\n\n' +
                    'Sélectionnez votre département :\n\n' +
                    '🛡️ **Justice du Parti** - Gestion de la modération\n' +
                    '📊 **Médailles du Mérite** - Statistiques et XP\n' +
                    '⚙️ **Directives du Parti** - Configuration'
                )
                .setColor('#CC0000')
                .setFooter({ text: 'Le Parti guide nos actions !' });

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('menu_mod')
                        .setLabel('Justice du Parti')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('🛡️'),
                    new ButtonBuilder()
                        .setCustomId('menu_stats')
                        .setLabel('Médailles du Mérite')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('📊'),
                    new ButtonBuilder()
                        .setCustomId('menu_config')
                        .setLabel('Directives du Parti')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('⚙️')
                );

            try {
                await interaction.update({
                    embeds: [mainEmbed],
                    components: [row]
                });
            } catch (error) {
                if (error.code === 10062) { // Unknown Interaction
                    // Si l'interaction est expirée, on crée une nouvelle réponse
                    await interaction.reply({
                        embeds: [mainEmbed],
                        components: [row],
                        ephemeral: true
                    });
                } else {
                    throw error;
                }
            }
        } catch (error) {
            console.error('Erreur lors du retour au menu principal:', error);
            try {
                await interaction.reply({
                    content: 'Une erreur s\'est produite lors du retour au menu principal. Utilisez `/dashboard` pour recommencer.',
                    ephemeral: true
                });
            } catch (replyError) {
                console.error('Erreur lors de la réponse d\'erreur:', replyError);
            }
        }
    }

    // Menu configuration
    else if (interaction.customId === 'menu_config') {
        try {
            db.get(
                'SELECT mod_role_id, leaderboard_channel_id, welcome_channel_id FROM guild_config WHERE guild_id = ?',
                [interaction.guildId],
                async (err, row) => {
                    if (err) {
                        console.error('Erreur SQL:', err);
                        return;
                    }

                    const currentModRole = row?.mod_role_id ? `<@&${row.mod_role_id}>` : 'Non assigné';
                    const currentChannel = row?.leaderboard_channel_id ? `<#${row.leaderboard_channel_id}>` : 'Non assigné';
                    const welcomeChannel = row?.welcome_channel_id ? `<#${row.welcome_channel_id}>` : 'Non assigné';

                    const row1 = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId('config_mod_role')
                                .setLabel('Garde Rouge')
                                .setStyle(ButtonStyle.Danger)
                                .setEmoji('👮'),
                            new ButtonBuilder()
                                .setCustomId('config_leaderboard')
                                .setLabel('Canal de Propagande')
                                .setStyle(ButtonStyle.Primary)
                                .setEmoji('📢'),
                            new ButtonBuilder()
                                .setCustomId('config_welcome_channel')
                                .setLabel('Canal d\'Accueil')
                                .setStyle(ButtonStyle.Primary)
                                .setEmoji('🚩'),
                            new ButtonBuilder()
                                .setCustomId('welcome_config')
                                .setLabel('Message d\'Accueil')
                                .setStyle(ButtonStyle.Primary)
                                .setEmoji('📨')
                        );

                    const row2 = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId('return_dashboard')
                                .setLabel('Retour')
                                .setStyle(ButtonStyle.Secondary)
                                .setEmoji('↩️')
                        );

                    const embed = new EmbedBuilder()
                        .setTitle('⚙️ Directives du Parti ⚙️')
                        .setDescription(
                            'Configuration actuelle :\n\n' +
                            `👮 **Garde Rouge** - ${currentModRole}\n` +
                            `📢 **Canal de Propagande** - ${currentChannel}\n` +
                            `🚩 **Canal d'Accueil** - ${welcomeChannel}\n` +
                            '📨 **Message d\'Accueil** - Message de bienvenue révolutionnaire'
                        )
                        .setColor('#CC0000')
                        .setFooter({ text: 'Le Parti guide nos actions !' });

                    try {
                        await interaction.update({ 
                            embeds: [embed], 
                            components: [row1, row2] 
                        });
                    } catch (error) {
                        if (error.code === 10062) {
                            await interaction.reply({
                                embeds: [embed],
                                components: [row1, row2],
                                ephemeral: true
                            });
                        } else {
                            throw error;
                        }
                    }
                }
            );
        } catch (error) {
            console.error('Erreur lors de l\'affichage du menu de configuration:', error);
            try {
                await interaction.reply({
                    content: 'Une erreur s\'est produite. Utilisez `/dashboard` pour recommencer.',
                    ephemeral: true
                });
            } catch (replyError) {
                console.error('Erreur lors de la réponse d\'erreur:', replyError);
            }
        }
    }

    // Sélection du rôle de modérateur
    else if (interaction.customId === 'select_mod_role') {
        const roleId = interaction.values[0];
        
        // Récupérer la configuration existante
        db.get('SELECT * FROM guild_config WHERE guild_id = ?', [interaction.guildId], (err, row) => {
            if (err) {
                console.error('Erreur lors de la vérification de la configuration:', err);
                return;
            }

            let query;
            let params;

            if (row) {
                // Mise à jour en préservant les autres valeurs
                query = `UPDATE guild_config SET 
                    mod_role_id = ?,
                    leaderboard_channel_id = COALESCE(leaderboard_channel_id, ?),
                    welcome_channel_id = COALESCE(welcome_channel_id, ?),
                    welcome_title = COALESCE(welcome_title, ?),
                    welcome_content = COALESCE(welcome_content, ?),
                    welcome_image = COALESCE(welcome_image, ?)
                    WHERE guild_id = ?`;
                params = [
                    roleId,
                    row.leaderboard_channel_id,
                    row.welcome_channel_id,
                    row.welcome_title,
                    row.welcome_content,
                    row.welcome_image,
                    interaction.guildId
                ];
            } else {
                // Première insertion
                query = `INSERT INTO guild_config (
                    guild_id, 
                    mod_role_id
                ) VALUES (?, ?)`;
                params = [interaction.guildId, roleId];
            }

            db.run(query, params, async function(err) {
                if (err) {
                    console.error('Erreur SQL lors de la sauvegarde du rôle:', err);
                    await interaction.reply({
                        content: '❌ Une erreur s\'est produite lors de la configuration du rôle !',
                        ephemeral: true
                    });
                    return;
                }

                console.log(`Configuration sauvegardée - Guild: ${interaction.guildId}, Role: ${roleId}, Changes: ${this.changes}`);

                const embed = new EmbedBuilder()
                    .setTitle('✅ Garde Rouge Configurée')
                    .setDescription(
                        `Le rôle ${interaction.guild.roles.cache.get(roleId)} a été promu Garde Rouge.\n\n` +
                        '_Ces camarades veilleront à la bonne application des directives du Parti !_'
                    )
                    .setColor('#CC0000')
                    .setFooter({ text: 'Configuration terminée' });

                const returnButton = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('menu_config')
                            .setLabel('Retour aux Directives')
                            .setStyle(ButtonStyle.Secondary)
                            .setEmoji('↩️')
                    );

                try {
                    await interaction.update({ 
                        embeds: [embed], 
                        components: [returnButton]
                    });
                } catch (error) {
                    console.error('Erreur lors de la mise à jour de l\'interaction:', error);
                    if (error.code === 10062) {
                        await interaction.reply({ 
                            embeds: [embed], 
                            components: [returnButton],
                            ephemeral: true 
                        });
                    } else {
                        throw error;
                    }
                }
            });
        });
    }

    // Sélection du canal de tableau d'honneur
    else if (interaction.customId === 'select_leaderboard_channel') {
        const channelId = interaction.values[0];
        
        // Récupérer la configuration existante
        db.get('SELECT * FROM guild_config WHERE guild_id = ?', [interaction.guildId], (err, row) => {
            if (err) {
                console.error('Erreur lors de la vérification de la configuration:', err);
                return;
            }

            let query;
            let params;

            if (row) {
                // Mise à jour en préservant les autres valeurs
                query = `UPDATE guild_config SET 
                    leaderboard_channel_id = ?,
                    mod_role_id = COALESCE(mod_role_id, ?),
                    welcome_channel_id = COALESCE(welcome_channel_id, ?),
                    welcome_title = COALESCE(welcome_title, ?),
                    welcome_content = COALESCE(welcome_content, ?),
                    welcome_image = COALESCE(welcome_image, ?)
                    WHERE guild_id = ?`;
                params = [
                    channelId,
                    row.mod_role_id,
                    row.welcome_channel_id,
                    row.welcome_title,
                    row.welcome_content,
                    row.welcome_image,
                    interaction.guildId
                ];
            } else {
                // Première insertion
                query = `INSERT INTO guild_config (
                    guild_id, 
                    leaderboard_channel_id
                ) VALUES (?, ?)`;
                params = [interaction.guildId, channelId];
            }

            db.run(query, params, async function(err) {
                if (err) {
                    console.error('Erreur SQL lors de la sauvegarde du canal:', err);
                    await interaction.reply({
                        content: '❌ Une erreur s\'est produite lors de la configuration du canal !',
                        ephemeral: true
                    });
                    return;
                }

                console.log(`Configuration sauvegardée - Guild: ${interaction.guildId}, Channel: ${channelId}, Changes: ${this.changes}`);

                const embed = new EmbedBuilder()
                    .setTitle('✅ Canal de Propagande Configuré')
                    .setDescription(
                        `Les tableaux d'honneur seront désormais publiés dans ${interaction.guild.channels.cache.get(channelId)}.\n\n` +
                        '_Le Parti se réjouit de pouvoir célébrer ses héros dans ce canal !_'
                    )
                    .setColor('#CC0000')
                    .setFooter({ text: 'Configuration terminée' });

                const returnButton = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('menu_config')
                            .setLabel('Retour aux Directives')
                            .setStyle(ButtonStyle.Secondary)
                            .setEmoji('↩️')
                    );

                try {
                    await interaction.update({ 
                        embeds: [embed], 
                        components: [returnButton]
                    });
                } catch (error) {
                    if (error.code === 10062) {
                        await interaction.reply({ 
                            embeds: [embed], 
                            components: [returnButton],
                            ephemeral: true 
                        });
                    } else {
                        throw error;
                    }
                }
            });
        });
    }

    // Menu Stats
    else if (interaction.customId === 'menu_stats') {
        db.get(
            'SELECT xp, weekly_xp FROM mod_xp WHERE user_id = ? AND guild_id = ?',
            [interaction.user.id, interaction.guildId],
            async (err, row) => {
                const xp = row ? row.xp : 0;
                const weeklyXp = row ? row.weekly_xp : 0;

                const row1 = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('stats_leaderboard')
                            .setLabel('Tableau d\'Honneur')
                            .setStyle(ButtonStyle.Primary)
                            .setEmoji('🏆'),
                        new ButtonBuilder()
                            .setCustomId('return_dashboard')
                            .setLabel('Retour')
                            .setStyle(ButtonStyle.Secondary)
                            .setEmoji('↩️')
                    );

                const embed = new EmbedBuilder()
                    .setTitle('🎖️ États de Service du Camarade 🎖️')
                    .setDescription(
                        `**Points de Mérite Total :** ${xp} PMR\n` +
                        `**Cette Semaine :** ${weeklyXp} PMR\n\n` +
                        '_"De chacun selon ses capacités, à chacun selon ses mérites."_'
                    )
                    .setColor('#CC0000')
                    .setFooter({ text: 'PMR = Points de Mérite Révolutionnaire' });

                await interaction.update({ embeds: [embed], components: [row1] });
            }
        );
    }

    // Menu Actions
    else if (interaction.customId === 'menu_mod') {
        const isMod = await isModerateur(interaction.member);
        if (!isMod) {
            await interaction.reply({ 
                content: '❌ Camarade, seuls les Gardes Rouges peuvent accéder aux actions !', 
                ephemeral: true 
            });
            return;
        }

        // Créer le menu de sélection d'utilisateur
        const members = await interaction.guild.members.fetch();
        const memberOptions = members
            .filter(member => !member.user.bot)
            .map(member => ({
                label: member.user.username,
                value: member.id,
                description: member.nickname || 'Camarade du Serveur'
            }))
            .slice(0, 25);

        const row = new ActionRowBuilder()
            .addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('select_user')
                    .setPlaceholder('Sélectionner un camarade')
                    .addOptions(memberOptions)
            );

        const row2 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('return_dashboard')
                    .setLabel('Retour')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('↩️')
            );

        const embed = new EmbedBuilder()
            .setTitle('☭ Bureau du Comité de Modération ☭')
            .setDescription(
                '1. Sélectionnez un camarade à rééduquer\n' +
                '2. Choisissez les mesures disciplinaires\n' +
                '3. Validez pour la gloire du Parti'
            )
            .setColor('#CC0000')
            .setFooter({ text: 'La justice du Parti est implacable !' });

        await interaction.update({ embeds: [embed], components: [row, row2] });
    }

    // Configuration du rôle de modérateur
    else if (interaction.customId === 'config_mod_role') {
        const roles = interaction.guild.roles.cache
            .filter(role => role.id !== interaction.guild.id) // Exclure le rôle @everyone
            .sort((a, b) => b.position - a.position) // Trier par position (plus haut en premier)
            .first(25);

        const row = new ActionRowBuilder()
            .addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('select_mod_role')
                    .setPlaceholder('Sélectionner le rôle de Garde Rouge')
                    .addOptions(
                        roles.map(role => ({
                            label: role.name,
                            value: role.id,
                            emoji: '👮'
                        }))
                    )
            );

        const embed = new EmbedBuilder()
            .setTitle('👮 Configuration de la Garde Rouge')
            .setDescription(
                'Sélectionnez le rôle qui aura les privilèges de modération.\n\n' +
                '_Ces camarades seront les gardiens de l\'ordre révolutionnaire._'
            )
            .setColor('#CC0000')
            .setFooter({ text: 'Pour la gloire de la Révolution !' });

        await interaction.update({ embeds: [embed], components: [row] });
    }

    // Sélection du rôle de modérateur
    else if (interaction.customId === 'select_mod_role') {
        const roleId = interaction.values[0];
        
        // Vérifier si une configuration existe déjà
        db.get('SELECT * FROM guild_config WHERE guild_id = ?', [interaction.guildId], (err, row) => {
            if (err) {
                console.error('Erreur lors de la vérification de la configuration:', err);
                return;
            }

            const query = row 
                ? 'UPDATE guild_config SET mod_role_id = ? WHERE guild_id = ?'
                : 'INSERT INTO guild_config (mod_role_id, guild_id) VALUES (?, ?)';
            
            const params = row ? [roleId, interaction.guildId] : [roleId, interaction.guildId];

            db.run(query, params, async function(err) {
                if (err) {
                    console.error('Erreur SQL lors de la sauvegarde du rôle:', err);
                    await interaction.reply({
                        content: '❌ Une erreur s\'est produite lors de la configuration du rôle !',
                        ephemeral: true
                    });
                    return;
                }

                console.log(`Configuration sauvegardée - Guild: ${interaction.guildId}, Role: ${roleId}, Changes: ${this.changes}`);

                const embed = new EmbedBuilder()
                    .setTitle('✅ Garde Rouge Configurée')
                    .setDescription(
                        `Le rôle ${interaction.guild.roles.cache.get(roleId)} a été promu Garde Rouge.\n\n` +
                        '_Ces camarades veilleront à la bonne application des directives du Parti !_'
                    )
                    .setColor('#CC0000')
                    .setFooter({ text: 'Configuration terminée' });

                const returnButton = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('menu_config')
                            .setLabel('Retour aux Directives')
                            .setStyle(ButtonStyle.Secondary)
                            .setEmoji('↩️')
                    );

                try {
                    await interaction.update({ 
                        embeds: [embed], 
                        components: [returnButton]
                    });
                } catch (error) {
                    console.error('Erreur lors de la mise à jour de l\'interaction:', error);
                    if (error.code === 10008) {
                        await interaction.reply({ 
                            embeds: [embed], 
                            components: [returnButton],
                            ephemeral: true 
                        });
                    } else {
                        throw error;
                    }
                }
            });
        });
    }

    // Configuration du canal
    else if (interaction.customId === 'config_leaderboard') {
        const channels = interaction.guild.channels.cache
            .filter(ch => ch.type === ChannelType.GuildText)
            .first(25);

        const row = new ActionRowBuilder()
            .addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('select_leaderboard_channel')
                    .setPlaceholder('Sélectionner le canal de propagande')
                    .addOptions(
                        channels.map(channel => ({
                            label: channel.name,
                            value: channel.id,
                            emoji: '📢'
                        }))
                    )
            );

        const embed = new EmbedBuilder()
            .setTitle('📢 Configuration du Canal de Propagande')
            .setDescription(
                'Sélectionnez le canal où seront publiés les tableaux d\'honneur.\n\n' +
                '_Le Parti y célébrera les exploits de ses plus fidèles serviteurs._'
            )
            .setColor('#CC0000')
            .setFooter({ text: 'Pour la gloire de la Révolution !' });

        await interaction.update({ embeds: [embed], components: [row] });
    }

    // Configuration du salon de bienvenue
    else if (interaction.customId === 'config_welcome_channel') {
        const channels = interaction.guild.channels.cache
            .filter(ch => ch.type === ChannelType.GuildText)
            .first(25);

        const row = new ActionRowBuilder()
            .addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('select_welcome_channel')
                    .setPlaceholder('Sélectionner le canal d\'accueil')
                    .addOptions(
                        channels.map(channel => ({
                            label: channel.name,
                            value: channel.id,
                            emoji: '🚩'
                        }))
                    )
            );

        const embed = new EmbedBuilder()
            .setTitle('🚩 Configuration du Canal d\'Accueil')
            .setDescription(
                'Sélectionnez le canal où seront envoyés les messages de bienvenue.\n\n' +
                '_Le Parti accueillera les nouveaux camarades dans ce canal._'
            )
            .setColor('#CC0000')
            .setFooter({ text: 'Pour la gloire de la Révolution !' });

        await interaction.update({ embeds: [embed], components: [row] });
    }

    // Sélection du salon de bienvenue
    else if (interaction.customId === 'select_welcome_channel') {
        const channelId = interaction.values[0];
        
        // Récupérer la configuration existante
        db.get('SELECT * FROM guild_config WHERE guild_id = ?', [interaction.guildId], (err, row) => {
            if (err) {
                console.error('Erreur lors de la vérification de la configuration:', err);
                return;
            }

            let query;
            let params;

            if (row) {
                // Mise à jour en préservant les autres valeurs
                query = `UPDATE guild_config SET 
                    welcome_channel_id = ?,
                    mod_role_id = COALESCE(mod_role_id, ?),
                    leaderboard_channel_id = COALESCE(leaderboard_channel_id, ?),
                    welcome_title = COALESCE(welcome_title, ?),
                    welcome_content = COALESCE(welcome_content, ?),
                    welcome_image = COALESCE(welcome_image, ?)
                    WHERE guild_id = ?`;
                params = [
                    channelId,
                    row.mod_role_id,
                    row.leaderboard_channel_id,
                    row.welcome_title,
                    row.welcome_content,
                    row.welcome_image,
                    interaction.guildId
                ];
            } else {
                // Première insertion
                query = `INSERT INTO guild_config (
                    guild_id, 
                    welcome_channel_id
                ) VALUES (?, ?)`;
                params = [interaction.guildId, channelId];
            }

            db.run(query, params, async function(err) {
                if (err) {
                    console.error('Erreur SQL lors de la sauvegarde du canal:', err);
                    await interaction.reply({
                        content: '❌ Une erreur s\'est produite lors de la configuration du canal !',
                        ephemeral: true
                    });
                    return;
                }

                console.log(`Configuration sauvegardée - Guild: ${interaction.guildId}, Welcome Channel: ${channelId}, Changes: ${this.changes}`);

                const embed = new EmbedBuilder()
                    .setTitle('✅ Canal d\'Accueil Configuré')
                    .setDescription(
                        `Les nouveaux camarades seront désormais accueillis dans ${interaction.guild.channels.cache.get(channelId)}.\n\n` +
                        '_Le Parti se réjouit d\'accueillir de nouveaux membres dans ce canal !_'
                    )
                    .setColor('#CC0000')
                    .setFooter({ text: 'Configuration terminée' });

                const returnButton = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('menu_config')
                            .setLabel('Retour aux Directives')
                            .setStyle(ButtonStyle.Secondary)
                            .setEmoji('↩️')
                    );

                try {
                    await interaction.update({ 
                        embeds: [embed], 
                        components: [returnButton]
                    });
                } catch (error) {
                    if (error.code === 10062) {
                        await interaction.reply({ 
                            embeds: [embed], 
                            components: [returnButton],
                            ephemeral: true 
                        });
                    } else {
                        throw error;
                    }
                }
            });
        });
    }

    // Sélection du canal de tableau d'honneur
    else if (interaction.customId === 'select_leaderboard_channel') {
        const channelId = interaction.values[0];
        
        db.run(
            'INSERT OR REPLACE INTO guild_config (guild_id, leaderboard_channel_id) VALUES (?, ?)',
            [interaction.guildId, channelId],
            async err => {
                if (err) {
                    console.error('Erreur SQL:', err);
                    await interaction.reply({
                        content: '❌ Une erreur s\'est produite lors de la configuration du canal !',
                        ephemeral: true
                    });
                    return;
                }

                const embed = new EmbedBuilder()
                    .setTitle('✅ Canal de Propagande Configuré')
                    .setDescription(
                        `Les tableaux d'honneur seront désormais publiés dans ${interaction.guild.channels.cache.get(channelId)}.\n\n` +
                        '_Le Parti se réjouit de pouvoir célébrer ses héros dans ce canal !_'
                    )
                    .setColor('#CC0000')
                    .setFooter({ text: 'Configuration terminée' });

                const returnButton = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('menu_config')
                            .setLabel('Retour aux Directives')
                            .setStyle(ButtonStyle.Secondary)
                            .setEmoji('↩️')
                    );

                try {
                    await interaction.update({ 
                        embeds: [embed], 
                        components: [returnButton]
                    });
                } catch (error) {
                    if (error.code === 10008) { // Unknown Message error
                        await interaction.reply({ 
                            embeds: [embed], 
                            components: [returnButton],
                            ephemeral: true 
                        });
                    } else {
                        throw error;
                    }
                }
            }
        );
    }

    // Configuration du message de bienvenue
    else if (interaction.customId === 'welcome_config') {
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('edit_welcome_message')
                    .setLabel('Message de Bienvenue')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('✍️'),
                new ButtonBuilder()
                    .setCustomId('edit_welcome_image')
                    .setLabel('Image de Bienvenue')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('🖼️'),
                new ButtonBuilder()
                    .setCustomId('test_welcome')
                    .setLabel('Tester')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('🔍'),
                new ButtonBuilder()
                    .setCustomId('return_config')
                    .setLabel('Retour')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('↩️')
            );

        const embed = new EmbedBuilder()
            .setTitle('☭ Configuration du Message de Bienvenue ☭')
            .setDescription(
                'Configurez le message qui accueillera les nouveaux camarades :\n\n' +
                '**Variables disponibles :**\n' +
                '`{user}` - Mention du nouveau membre\n' +
                '`{server}` - Nom du serveur\n' +
                '`{memberCount}` - Nombre total de membres'
            )
            .setColor('#CC0000')
            .setFooter({ text: 'Un accueil chaleureux pour nos camarades !' });

        await interaction.update({ embeds: [embed], components: [row] });
    }

    // Modal pour éditer le message de bienvenue
    else if (interaction.customId === 'edit_welcome_message') {
        try {
            const modal = new ModalBuilder()
                .setCustomId('welcome_modal')
                .setTitle('Message de Bienvenue');

            const titleInput = new TextInputBuilder()
                .setCustomId('welcome_title')
                .setLabel('Titre du message')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Bienvenue Camarade ✋')
                .setRequired(true)
                .setMaxLength(100);

            const messageInput = new TextInputBuilder()
                .setCustomId('welcome_content')
                .setLabel('Message')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Un nouveau camarade {user} rejoint notre révolution !')
                .setRequired(true)
                .setMaxLength(2000);

            const row1 = new ActionRowBuilder().addComponents(titleInput);
            const row2 = new ActionRowBuilder().addComponents(messageInput);

            modal.addComponents(row1, row2);
            await interaction.showModal(modal);
        } catch (error) {
            console.error('Erreur lors de l\'affichage du modal:', error);
            await interaction.reply({ 
                content: '❌ Une erreur s\'est produite lors de l\'affichage du formulaire !', 
                ephemeral: true 
            });
        }
    }

    // Gérer la soumission du modal de message
    else if (interaction.customId === 'welcome_modal') {
        try {
            const title = interaction.fields.getTextInputValue('welcome_title');
            const content = interaction.fields.getTextInputValue('welcome_content');

            // Mise à jour de la configuration
            db.run(`
                INSERT INTO guild_config (guild_id, welcome_title, welcome_content) 
                VALUES (?, ?, ?)
                ON CONFLICT(guild_id) 
                DO UPDATE SET 
                    welcome_title = excluded.welcome_title,
                    welcome_content = excluded.welcome_content
            `, [interaction.guildId, title, content], async (err) => {
                if (err) {
                    console.error('Erreur SQL:', err);
                    await interaction.reply({ 
                        content: '❌ Une erreur s\'est produite lors de la sauvegarde !', 
                        ephemeral: true 
                    });
                    return;
                }

                // Retour au menu de configuration du message de bienvenue
                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('edit_welcome_message')
                            .setLabel('Message de Bienvenue')
                            .setStyle(ButtonStyle.Primary)
                            .setEmoji('✍️'),
                        new ButtonBuilder()
                            .setCustomId('edit_welcome_image')
                            .setLabel('Image de Bienvenue')
                            .setStyle(ButtonStyle.Primary)
                            .setEmoji('🖼️'),
                        new ButtonBuilder()
                            .setCustomId('test_welcome')
                            .setLabel('Tester')
                            .setStyle(ButtonStyle.Success)
                            .setEmoji('🔍'),
                        new ButtonBuilder()
                            .setCustomId('return_config')
                            .setLabel('Retour')
                            .setStyle(ButtonStyle.Secondary)
                            .setEmoji('↩️')
                    );

                const embed = new EmbedBuilder()
                    .setTitle('✅ Message de Bienvenue Configuré')
                    .setDescription(
                        'Le message a été enregistré avec succès !\n\n' +
                        '**Aperçu :**\n' +
                        `**${title}**\n` +
                        content.replace('{user}', interaction.user)
                            .replace('{server}', interaction.guild.name)
                            .replace('{memberCount}', interaction.guild.memberCount)
                    )
                    .setColor('#CC0000')
                    .setFooter({ text: 'Utilisez le bouton "Tester" pour voir le résultat final' });

                await interaction.reply({ 
                    embeds: [embed], 
                    components: [row],
                    ephemeral: true 
                });
            });
        } catch (error) {
            console.error('Erreur lors du traitement du modal:', error);
            await interaction.reply({ 
                content: '❌ Une erreur s\'est produite lors du traitement du formulaire !', 
                ephemeral: true 
            });
        }
    }

    // Modal pour l'URL de l'image de bienvenue
    else if (interaction.customId === 'edit_welcome_image') {
        const modal = new ModalBuilder()
            .setCustomId('welcome_image_modal')
            .setTitle('Image de Bienvenue');

        const imageInput = new TextInputBuilder()
            .setCustomId('welcome_image_url')
            .setLabel('URL de l\'image')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('https://exemple.com/image.png')
            .setRequired(true);

        const row = new ActionRowBuilder().addComponents(imageInput);
        modal.addComponents(row);
        await interaction.showModal(modal);
    }

    // Gérer la soumission du modal d'image
    else if (interaction.customId === 'welcome_image_modal') {
        const imageUrl = interaction.fields.getTextInputValue('welcome_image_url');

        // Vérifier si une configuration existe déjà
        db.get(
            'SELECT * FROM guild_config WHERE guild_id = ?',
            [interaction.guildId],
            (err, row) => {
                if (err) {
                    console.error('Erreur SQL:', err);
                    interaction.reply({ 
                        content: '❌ Une erreur s\'est produite !', 
                        ephemeral: true 
                    });
                    return;
                }

                if (row) {
                    // Mise à jour si existe
                    db.run(
                        'UPDATE guild_config SET welcome_image = ? WHERE guild_id = ?',
                        [imageUrl, interaction.guildId],
                        async (err) => {
                            if (err) {
                                console.error('Erreur SQL:', err);
                                await interaction.reply({ 
                                    content: '❌ Une erreur s\'est produite !', 
                                    ephemeral: true 
                                });
                                return;
                            }

                            const embed = new EmbedBuilder()
                                .setTitle('✅ Image de Bienvenue Configurée')
                                .setDescription('L\'image a été enregistrée avec succès !')
                                .setColor('#CC0000');

                            await interaction.reply({ embeds: [embed], ephemeral: true });
                        }
                    );
                } else {
                    // Insertion si n'existe pas
                    db.run(
                        'INSERT INTO guild_config (guild_id, welcome_image) VALUES (?, ?)',
                        [interaction.guildId, imageUrl],
                        async (err) => {
                            if (err) {
                                console.error('Erreur SQL:', err);
                                await interaction.reply({ 
                                    content: '❌ Une erreur s\'est produite !', 
                                    ephemeral: true 
                                });
                                return;
                            }

                            const embed = new EmbedBuilder()
                                .setTitle('✅ Image de Bienvenue Configurée')
                                .setDescription('L\'image a été enregistrée avec succès !')
                                .setColor('#CC0000');

                            await interaction.reply({ embeds: [embed], ephemeral: true });
                        }
                    );
                }
            }
        );
    }

    // Tester le message de bienvenue
    else if (interaction.customId === 'test_welcome') {
        db.get(
            'SELECT welcome_title, welcome_content, welcome_image FROM guild_config WHERE guild_id = ?',
            [interaction.guildId],
            async (err, row) => {
                if (err || !row) {
                    await interaction.reply({ 
                        content: '❌ Aucune configuration trouvée !', 
                        ephemeral: true 
                    });
                    return;
                }

                const title = row.welcome_title?.replace('{user}', interaction.user)
                    .replace('{server}', interaction.guild.name)
                    .replace('{memberCount}', interaction.guild.memberCount) || 'Bienvenue Camarade ✋';

                const content = row.welcome_content?.replace('{user}', interaction.user)
                    .replace('{server}', interaction.guild.name)
                    .replace('{memberCount}', interaction.guild.memberCount) ||
                    `Un nouveau camarade ${interaction.user} rejoint notre révolution !`;

                const embed = new EmbedBuilder()
                    .setTitle(title)
                    .setDescription(content)
                    .setColor('#CC0000');

                if (row.welcome_image) {
                    embed.setImage(row.welcome_image);
                }

                await interaction.reply({ 
                    content: '📝 Prévisualisation du message de bienvenue :', 
                    embeds: [embed], 
                    ephemeral: true 
                });
            }
        );
    }

    // Bouton Retour - Retour au dashboard principal
    else if (interaction.customId === 'return_dashboard') {
        const mainRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('menu_mod')
                    .setLabel('Justice du Parti')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('⚔️'),
                new ButtonBuilder()
                    .setCustomId('menu_stats')
                    .setLabel('Médailles du Mérite')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('🎖️'),
                new ButtonBuilder()
                    .setCustomId('menu_config')
                    .setLabel('Directives du Parti')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('⚙️')
            );

        const mainEmbed = new EmbedBuilder()
            .setTitle('☭ Bureau Politique du Parti ☭')
            .setDescription(
                'Bienvenue, Camarade ! Le Parti vous salue !\n\n' +
                '⚔️ **Justice du Parti** - Faire respecter la discipline révolutionnaire\n' +
                '🎖️ **Médailles du Mérite** - Honorer les services rendus au Parti\n' +
                '⚙️ **Directives du Parti** - Appliquer la ligne politique'
            )
            .setColor('#CC0000')
            .setFooter({ text: 'Pour la gloire de la Révolution !' });

        try {
            await interaction.update({ embeds: [mainEmbed], components: [mainRow] });
        } catch (error) {
            console.error('Erreur lors du retour au menu principal:', error);
        }
    }

    // Traitement des modaux de configuration
    else if (interaction.isModalSubmit()) {
        if (interaction.customId === 'modal_role') {
            const roleId = interaction.fields.getTextInputValue('role_id');
            
            db.run(
                'INSERT INTO guild_config (guild_id, mod_role_id) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET mod_role_id = ?',
                [interaction.guildId, roleId, roleId],
                async (err) => {
                    if (err) {
                        await interaction.reply({ 
                            content: '❌ Une erreur s\'est produite !', 
                            ephemeral: true 
                        });
                        return;
                    }

                    const embed = new EmbedBuilder()
                        .setTitle('✅ Configuration Mise à Jour')
                        .setDescription(`Le rôle Garde Rouge a été défini avec l'ID: ${roleId}`)
                        .setColor('#CC0000');

                    await interaction.reply({ embeds: [embed], ephemeral: true });
                }
            );
        }
        else if (interaction.customId === 'modal_channel') {
            const channelId = interaction.fields.getTextInputValue('channel_id');
            
            db.run(
                'INSERT INTO guild_config (guild_id, leaderboard_channel_id) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET leaderboard_channel_id = ?',
                [interaction.guildId, channelId, channelId],
                async (err) => {
                    if (err) {
                        await interaction.reply({ 
                            content: '❌ Une erreur s\'est produite !', 
                            ephemeral: true 
                        });
                        return;
                    }

                    const embed = new EmbedBuilder()
                        .setTitle('✅ Configuration Mise à Jour')
                        .setDescription(`Le Canal des Héros a été défini avec l'ID: ${channelId}`)
                        .setColor('#CC0000');

                    await interaction.reply({ embeds: [embed], ephemeral: true });
                }
            );
        }
    }

    // Sélection d'un utilisateur
    else if (interaction.customId === 'select_user') {
        const userId = interaction.values[0];
        const user = await client.users.fetch(userId);

        // Créer les boutons d'action
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`warn_${userId}`)
                    .setLabel('Avertissement (2 PMR)')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('⚠️'),
                new ButtonBuilder()
                    .setCustomId(`mute_${userId}`)
                    .setLabel('Rééducation (3 PMR)')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('🔇'),
                new ButtonBuilder()
                    .setCustomId(`kick_${userId}`)
                    .setLabel('Exil (5 PMR)')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('👢'),
                new ButtonBuilder()
                    .setCustomId(`ban_${userId}`)
                    .setLabel('Goulag (10 PMR)')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('⛏️')
            );

        const row2 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`validate_${userId}`)
                    .setLabel('✅ Appliquer les Sanctions')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`cancel_${userId}`)
                    .setLabel('❌ Annuler')
                    .setStyle(ButtonStyle.Secondary)
            );

        // Initialiser les actions en attente
        pendingActions.set(userId, []);

        const embed = new EmbedBuilder()
            .setTitle(`☭ Dossier du Camarade ${user.tag} ☭`)
            .setDescription(
                'Sélectionnez les mesures disciplinaires à appliquer.\n' +
                'Plusieurs sanctions peuvent être appliquées simultanément.'
            )
            .setThumbnail(user.displayAvatarURL())
            .setColor('#CC0000')
            .setFooter({ text: 'La justice du Parti est implacable !' });

        await interaction.update({ embeds: [embed], components: [row, row2] });
    }

    // Ajout d'une action
    else if (interaction.customId.startsWith('warn_') || 
             interaction.customId.startsWith('mute_') || 
             interaction.customId.startsWith('kick_') || 
             interaction.customId.startsWith('ban_')) {
        
        const [action, userId] = interaction.customId.split('_');
        const user = await client.users.fetch(userId);
        const actions = pendingActions.get(userId) || [];
        
        actions.push(action);
        pendingActions.set(userId, actions);

        const actionNames = {
            'warn': 'Avertissement',
            'mute': 'Rééducation',
            'kick': 'Exil',
            'ban': 'Goulag'
        };

        const embed = new EmbedBuilder()
            .setTitle(`☭ Dossier du Camarade ${user.tag} ☭`)
            .setDescription(
                '**Sanctions sélectionnées :**\n' +
                actions.map(a => `- ${actionNames[a]}`).join('\n')
            )
            .setThumbnail(user.displayAvatarURL())
            .setColor('#CC0000')
            .setFooter({ text: 'Pour la gloire du Parti !' });

        await interaction.update({ embeds: [embed] });
    }

    // Validation des actions
    else if (interaction.customId.startsWith('validate_')) {
        const userId = interaction.customId.split('_')[1];
        const actions = pendingActions.get(userId) || [];
        const user = await client.users.fetch(userId);
        const weekNumber = getWeekNumber();

        if (actions.length === 0) {
            await interaction.reply({ 
                content: '❌ Camarade, aucune sanction n\'a été sélectionnée !', 
                ephemeral: true 
            });
            return;
        }

        let totalXp = 0;
        const results = [];

        const actionNames = {
            'warn': 'Avertissement',
            'mute': 'Rééducation',
            'kick': 'Exil',
            'ban': 'Goulag'
        };

        for (const action of actions) {
            const xp = CONFIG.XP_ACTIONS[action.toUpperCase()];
            totalXp += xp;

            // Ajouter les XP
            db.run(
                'INSERT INTO mod_xp (user_id, guild_id, xp, weekly_xp) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, guild_id) DO UPDATE SET xp = xp + ?, weekly_xp = weekly_xp + ?',
                [interaction.user.id, interaction.guildId, xp, xp, xp, xp]
            );

            // Enregistrer l'action
            db.run(
                'INSERT INTO mod_actions (mod_id, action, details, xp, week_number) VALUES (?, ?, ?, ?, ?)',
                [interaction.user.id, action.toUpperCase(), `Application de sanctions sur ${user.tag}`, xp, weekNumber]
            );

            results.push(`✅ ${actionNames[action]} appliqué au camarade ${user.tag} : +${xp} PMR`);
        }

        const embed = new EmbedBuilder()
            .setTitle('☭ Sanctions Appliquées ☭')
            .setDescription(results.join('\n'))
            .setFooter({ 
                text: `Total des Points de Mérite Révolutionnaire : +${totalXp} PMR\nLe Parti vous remercie de votre vigilance !` 
            })
            .setColor('#CC0000')
            .setTimestamp();

        pendingActions.delete(userId);
        await interaction.update({ embeds: [embed], components: [] });
    }

    // Annulation
    else if (interaction.customId.startsWith('cancel_')) {
        const userId = interaction.customId.split('_')[1];
        pendingActions.delete(userId);
        await interaction.update({ 
            content: '❌ Procédure disciplinaire annulée', 
            components: [], 
            embeds: [] 
        });
    }

    // Voir le leaderboard
    else if (interaction.customId === 'stats_leaderboard') {
        const channels = await interaction.guild.channels.fetch();
        const textChannels = channels
            .filter(channel => channel.type === ChannelType.GuildText)
            .map(channel => ({
                label: channel.name,
                value: channel.id,
                description: 'Canal textuel'
            }))
            .slice(0, 25);

        const row = new ActionRowBuilder()
            .addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('select_leaderboard_channel')
                    .setPlaceholder('Sélectionner le canal d\'envoi')
                    .addOptions(textChannels)
            );

        const row2 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('return_stats')
                    .setLabel('Retour')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('↩️')
            );

        const embed = new EmbedBuilder()
            .setTitle('☭ Tableau d\'Honneur du Parti ☭')
            .setDescription('Sélectionnez le canal où envoyer le tableau d\'honneur')
            .setColor('#CC0000')
            .setFooter({ text: 'La gloire du Parti doit être proclamée !' });

        await interaction.update({ embeds: [embed], components: [row, row2] });
    }

    // Sélection du canal pour le leaderboard
    else if (interaction.customId === 'select_leaderboard_channel') {
        const channelId = interaction.values[0];
        const channel = await interaction.guild.channels.fetch(channelId);

        // Générer et envoyer le leaderboard
        db.all(`
            SELECT 
                user_id,
                SUM(weekly_xp) as total_xp
            FROM mod_xp 
            WHERE guild_id = ?
            GROUP BY user_id
            ORDER BY total_xp DESC
            LIMIT 10
        `, [interaction.guildId], async (err, rows) => {
            if (err) {
                await interaction.reply({ 
                    content: '❌ Une erreur s\'est produite !', 
                    ephemeral: true 
                });
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle('☭ Héros de la Modération ☭')
                .setColor('#CC0000')
                .setDescription('Voici nos plus valeureux défenseurs du prolétariat :')
                .setTimestamp()
                .setFooter({ text: 'Le Parti salue votre dévouement !' });

            for (let i = 0; i < rows.length; i++) {
                const user = await client.users.fetch(rows[i].user_id);
                const rank = ['⭐', '🎖️', '🏅', '🌟', '✨'][i] || '•';
                embed.addFields({
                    name: `${rank} ${user.tag}`,
                    value: `${rows[i].total_xp} Points de Mérite Révolutionnaire`
                });
            }

            await channel.send({ embeds: [embed] });

            const confirmEmbed = new EmbedBuilder()
                .setTitle('✅ Tableau d\'Honneur Publié')
                .setDescription(`Le tableau d'honneur a été publié dans ${channel}`)
                .setColor('#CC0000');

            await interaction.update({ embeds: [confirmEmbed], components: [] });
        });
    }

    // Retour au menu stats
    else if (interaction.customId === 'return_stats') {
        db.get(
            'SELECT xp, weekly_xp FROM mod_xp WHERE user_id = ? AND guild_id = ?',
            [interaction.user.id, interaction.guildId],
            async (err, row) => {
                const xp = row ? row.xp : 0;
                const weeklyXp = row ? row.weekly_xp : 0;

                const row1 = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('stats_leaderboard')
                            .setLabel('Tableau d\'Honneur')
                            .setStyle(ButtonStyle.Primary)
                            .setEmoji('🏆'),
                        new ButtonBuilder()
                            .setCustomId('return_dashboard')
                            .setLabel('Retour')
                            .setStyle(ButtonStyle.Secondary)
                            .setEmoji('↩️')
                    );

                const embed = new EmbedBuilder()
                    .setTitle('🎖️ États de Service du Camarade 🎖️')
                    .setDescription(
                        `**Points de Mérite Total :** ${xp} PMR\n` +
                        `**Cette Semaine :** ${weeklyXp} PMR\n\n` +
                        '_"De chacun selon ses capacités, à chacun selon ses mérites."_'
                    )
                    .setColor('#CC0000')
                    .setFooter({ text: 'PMR = Points de Mérite Révolutionnaire' });

                await interaction.update({ embeds: [embed], components: [row1] });
            }
        );
    }
});

// Gérer les messages pour l'XP
client.on('messageCreate', async message => {
    if (message.author.bot) return;
    
    const isMod = await isModerateur(message.member);
    if (!isMod) return;

    const now = Date.now();
    const lastMessage = messageCooldowns.get(message.author.id);
    
    if (lastMessage && (now - lastMessage) < CONFIG.COOLDOWN_MESSAGE) return;
    
    messageCooldowns.set(message.author.id, now);

    // Ajouter l'XP
    db.run(
        'INSERT INTO mod_xp (user_id, guild_id, xp, weekly_xp) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, guild_id) DO UPDATE SET xp = xp + ?, weekly_xp = weekly_xp + ?',
        [message.author.id, message.guild.id, CONFIG.XP_PAR_MESSAGE, CONFIG.XP_PAR_MESSAGE, CONFIG.XP_PAR_MESSAGE, CONFIG.XP_PAR_MESSAGE]
    );
});

// Ajouter l'event pour les nouveaux membres
client.on('guildMemberAdd', async member => {
    try {
        // Récupérer la configuration du serveur
        const configRow = await new Promise((resolve, reject) => {
            db.get(
                'SELECT welcome_title, welcome_content, welcome_image, welcome_channel_id FROM guild_config WHERE guild_id = ?',
                [member.guild.id],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });

        // Préparer le titre et le contenu
        const title = (configRow?.welcome_title || `☭ Bienvenue au Parti, Camarade {user} ! ☭`)
            .replace('{user}', member.user.username)
            .replace('{server}', member.guild.name)
            .replace('{memberCount}', member.guild.memberCount);

        const content = (configRow?.welcome_content || 
            `Le Parti accueille chaleureusement {user} dans nos rangs !\nTu es notre {memberCount}ème camarade.`)
            .replace('{user}', `<@${member.id}>`)
            .replace('{server}', member.guild.name)
            .replace('{memberCount}', member.guild.memberCount);

        // Créer l'embed
        const welcomeEmbed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(content)
            .setColor('#CC0000')
            .setThumbnail(member.user.displayAvatarURL({ 
                dynamic: true, 
                size: 256,
                format: 'png'
            }))
            .setTimestamp()
            .setFooter({ 
                text: 'Pour la gloire de la Révolution !',
                iconURL: member.guild.iconURL({ dynamic: true })
            });

        // Ajouter l'image personnalisée si elle existe
        if (configRow?.welcome_image) {
            welcomeEmbed.setImage(configRow.welcome_image);
        }

        // Utiliser le salon configuré ou chercher un salon par défaut
        let welcomeChannel;
        if (configRow?.welcome_channel_id) {
            welcomeChannel = member.guild.channels.cache.get(configRow.welcome_channel_id);
        }

        // Si pas de salon configuré ou salon invalide, chercher un salon par défaut
        if (!welcomeChannel || !welcomeChannel.permissionsFor(client.user).has(PermissionsBitField.Flags.SendMessages)) {
            welcomeChannel = member.guild.channels.cache.find(
                ch => ch.type === ChannelType.GuildText && (
                    ch.name.includes('bienvenue') ||
                    ch.name.includes('welcome') ||
                    ch.name.includes('arrivée') ||
                    ch.name.includes('arrivees') ||
                    ch.name.includes('général') ||
                    ch.name.includes('general')
                ) && ch.permissionsFor(client.user).has(PermissionsBitField.Flags.SendMessages)
            );
        }

        // Si toujours pas de salon, utiliser le premier salon disponible
        if (!welcomeChannel) {
            welcomeChannel = member.guild.channels.cache
                .find(ch => ch.type === ChannelType.GuildText && 
                    ch.permissionsFor(client.user).has(PermissionsBitField.Flags.SendMessages));
        }

        if (welcomeChannel) {
            await welcomeChannel.send({ 
                content: `<@${member.id}>`,  // Mention explicite
                embeds: [welcomeEmbed],
                allowedMentions: { users: [member.id] }  // S'assurer que la mention fonctionne
            });
        }
    } catch (error) {
        console.error('Erreur lors de l\'envoi du message de bienvenue:', error);
    }
});

client.login(process.env.TOKEN);
