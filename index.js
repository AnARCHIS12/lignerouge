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
    UserSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
    ModalBuilder,
    PermissionsBitField,
    ActivityType,
    RoleSelectMenuBuilder,
    ChannelSelectMenuBuilder
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
    XP_MULTIPLICATEUR: 1.5,
    COOLDOWN: 60000,
    ACTIONS: {
        // Actions de modération de base
        WARN: { xp: 5, description: 'Avertissement' },
        MUTE: { xp: 10, description: 'Réduction au silence' },
        KICK: { xp: 15, description: 'Exclusion' },
        BAN: { xp: 25, description: 'Bannissement' },
        DELETE: { xp: 3, description: 'Suppression de message' },
        TIMEOUT: { xp: 8, description: 'Mise en isolement' },
        
        // Actions de douane et accueil
        CONTROLE_DOUANE: { xp: 790, description: 'Contrôle à la douane' },
        EXPULSION_CENTRE: { xp: 270, description: 'Expulsion vers le centre d\'apprentissage' },
        ACCUEIL_SIMPLE: { xp: 2500, description: 'Accueil des nouveaux' },
        ACCUEIL_SUIVI: { xp: 10500, description: 'Accueil avec suivi (10+ messages)' },
        REATTRIBUTION_NUMERO: { xp: 20, description: 'Réattribution de numéro d\'apprentis' },
        
        // Actions d'animation
        DEBAT: { xp: 900, description: 'Proposer un débat' },
        DEBAT_ACTIF: { xp: 3000, description: 'Débat générant +25 messages' },
        SONDAGE: { xp: 1400, description: 'Proposer un sondage' },
        CONCOURS: { xp: 2500, description: 'Proposer un petit concours' },
        EVENT: { xp: 9500, description: 'Proposer un event/tournois' },
        VOCAL: { xp: 3000, description: 'Proposer un vocal (+20 min)' },
        
        // Actions de contenu
        MEME: { xp: 2000, description: 'Créer un meme' },
        MEME_VALIDE: { xp: 3000, description: 'Meme validé par le rôle inconnu' },
        VIDEO: { xp: 15000, description: 'Créer une vidéo' },
        REPOST: { xp: 700, description: 'Republier un post' },
        
        // Actions pédagogiques
        FICHE_PRISONNIER: { xp: 4500, description: 'Créer une fiche prisonnier' },
        COURS: { xp: 8000, description: 'Délivrer un cours aux camarades' },
        APPRENTISSAGE: { xp: 10000, description: 'Apprendre une notion à un apprentis' },
        EVOLUTION_NOTE: { xp: 3000, description: 'Faire évoluer la note d\'un apprentis' },
        
        // Actions de progression
        ETAPE_AUTONOMIE: { xp: 30000, description: 'Passer une étape d\'autonomie' },
        PUBLICATION_SOCIALE: { xp: 4000, description: 'Publier sur un réseau social' },
        
        // Actions de sécurité
        LISTE_SUSPECT: { xp: 800, description: 'Lister un suspect' },
        PREUVE_SUSPICION: { xp: 4000, description: 'Apporter des preuves à la suspicion' },
        ARRET_INTRUS: { xp: 600, description: 'Arrêter un intrus' },
        
        // Actions journal
        ARTICLE: { xp: 8000, description: 'Rédiger un article' },
        INTERVIEW: { xp: 3000, description: 'Mener une interview' }
    }
};

// Configuration du leaderboard
let leaderboardJob;
const DEFAULT_LEADERBOARD_TIME = '0 0 * * 0'; // Dimanche à minuit par défaut

// Fonction pour mettre à jour le cron du leaderboard
function updateLeaderboardSchedule(cronExpression) {
    if (leaderboardJob) {
        leaderboardJob.stop();
    }
    
    leaderboardJob = cron.schedule(cronExpression, async () => {
        console.log('🕛 Démarrage de l\'envoi du classement hebdomadaire...');
        for (const [guildId] of client.guilds.cache) {
            try {
                console.log(`📊 Tentative d'envoi du classement pour le serveur ${guildId}...`);
                await sendWeeklySummary(guildId);
                console.log(`✅ Classement envoyé avec succès pour le serveur ${guildId}`);
            } catch (error) {
                console.error(`❌ Erreur lors de l'envoi du leaderboard pour ${guildId}:`, error);
            }
        }
        console.log('🏁 Fin de l\'envoi des classements hebdomadaires');
    }, {
        scheduled: true,
        timezone: "Europe/Paris"
    });
}

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
                console.log('Table mod_xp vérifiée avec succès');
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
                console.log('Table mod_actions vérifiée avec succès');
            }
        });

        // Table de configuration
        db.run(`
            CREATE TABLE IF NOT EXISTS guild_config (
                guild_id TEXT PRIMARY KEY,
                mod_role_id TEXT,
                leaderboard_channel_id TEXT,
                welcome_channel_id TEXT,
                welcome_title TEXT,
                welcome_content TEXT,
                welcome_image TEXT,
                leaderboard_time TEXT DEFAULT '0 0 * * 0'
            )
        `, err => {
            if (err) {
                console.error('Erreur lors de la création de la table guild_config:', err);
            } else {
                console.log('Table guild_config vérifiée avec succès');
            }
        });

        // Table des destinataires des rapports
        db.run(`CREATE TABLE IF NOT EXISTS report_recipients (
            guild_id TEXT,
            user_id TEXT,
            PRIMARY KEY (guild_id, user_id)
        )`, err => {
            if (err) {
                console.error('Erreur lors de la création de la table report_recipients:', err);
            } else {
                console.log('Table report_recipients vérifiée avec succès');
            }
        });
    });
}

// Migration : Ajouter la colonne leaderboard_time si elle n'existe pas
db.get("PRAGMA table_info(guild_config)", (err, rows) => {
    if (err) {
        console.error('Erreur lors de la vérification de la structure de la table:', err);
        return;
    }
    
    // Vérifier si la colonne existe déjà
    db.get("SELECT COUNT(*) as count FROM pragma_table_info('guild_config') WHERE name='leaderboard_time'", (err, row) => {
        if (err) {
            console.error('Erreur lors de la vérification de la colonne:', err);
            return;
        }

        if (row.count === 0) {
            console.log('📊 Ajout de la colonne leaderboard_time...');
            db.run("ALTER TABLE guild_config ADD COLUMN leaderboard_time TEXT DEFAULT '0 0 * * 0'", (err) => {
                if (err) {
                    console.error('Erreur lors de l\'ajout de la colonne:', err);
                } else {
                    console.log('✅ Colonne leaderboard_time ajoutée avec succès');
                }
            });
        }
    });
});

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
            description: '🛠️ Bureau Politique du Parti 🛠️'
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

// Fonction pour vérifier le rôle de modérateur
async function checkModRole(interaction) {
    try {
        // Vérifier si l'utilisateur est administrateur
        if (interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return true;
        }

        // Récupérer le rôle de modérateur depuis la base de données
        const config = await new Promise((resolve, reject) => {
            db.get('SELECT mod_role_id FROM guild_config WHERE guild_id = ?', 
                [interaction.guildId], 
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });

        // Si aucun rôle n'est configuré
        if (!config?.mod_role_id) {
            await interaction.reply({
                content: '❌ Le rôle de modérateur n\'est pas configuré. Un administrateur doit d\'abord configurer le rôle via le menu de configuration.',
                ephemeral: true
            });
            return false;
        }

        // Vérifier si l'utilisateur a le rôle
        const hasRole = interaction.member.roles.cache.has(config.mod_role_id);
        if (!hasRole) {
            await interaction.reply({
                content: '❌ Vous n\'avez pas la permission d\'utiliser cette commande.',
                ephemeral: true
            });
            return false;
        }

        return true;
    } catch (error) {
        console.error('Erreur lors de la vérification du rôle de modérateur:', error);
        await interaction.reply({
            content: '❌ Une erreur s\'est produite lors de la vérification des permissions.',
            ephemeral: true
        });
        return false;
    }
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
client.once('ready', () => {
    // Attendre que le client soit prêt avant d'initialiser le cron
    setTimeout(() => {
        const firstGuild = client.guilds.cache.first();
        if (firstGuild) {
            db.get('SELECT leaderboard_time FROM guild_config WHERE guild_id = ?', 
                [firstGuild.id], 
                (err, row) => {
                    if (err) {
                        console.error('Erreur SQL:', err);
                        return;
                    }

                    const leaderboardTime = row?.leaderboard_time || DEFAULT_LEADERBOARD_TIME;
                    console.log(`📅 Planification du classement : ${leaderboardTime}`);
                    updateLeaderboardSchedule(leaderboardTime);
                }
            );
        } else {
            console.log('⚠️ Aucun serveur trouvé pour initialiser le classement');
            updateLeaderboardSchedule(DEFAULT_LEADERBOARD_TIME);
        }
    }, 1000); // Attendre 1 seconde pour s'assurer que tout est initialisé
});

// Gérer les interactions
client.on('interactionCreate', async interaction => {
    if (!interaction.guild) return;

    // Vérifier si c'est un bouton, une commande ou un menu
    if (!interaction.isCommand() && !interaction.isStringSelectMenu() && !interaction.isButton() && !interaction.isModalSubmit() && !interaction.isUserSelectMenu() && !interaction.isRoleSelectMenu() && !interaction.isChannelSelectMenu()) return;

    // Vérifier les permissions pour la configuration
    if (interaction.customId?.startsWith('config_') || 
        interaction.customId === 'welcome_config' || 
        interaction.customId === 'edit_welcome_message' || 
        interaction.customId === 'edit_welcome_image' ||
        interaction.customId === 'test_welcome' ||
        interaction.customId === 'menu_config') {
        
        // Vérifier si l'utilisateur a les permissions d'administrateur
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            await interaction.update({ 
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
                    await interaction.update({ 
                        content: '❌ Aucun rôle de modération configuré. Seuls les administrateurs peuvent utiliser ces commandes !', 
                        ephemeral: true 
                    });
                    return;
                }
            } else {
                // Vérifier si l'utilisateur a le rôle de modération ou est administrateur
                if (!interaction.member.roles.cache.has(modRoleId) && 
                    !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                    await interaction.update({ 
                        content: '❌ Vous n\'avez pas les permissions nécessaires !', 
                        ephemeral: true 
                    });
                    return;
                }
            }
        } catch (error) {
            console.error('Erreur lors de la vérification des permissions:', error);
            await interaction.update({ 
                content: '❌ Une erreur s\'est produite lors de la vérification des permissions !', 
                ephemeral: true 
            });
            return;
        }
    }

    // Menu principal - Dashboard
    if (interaction.commandName === 'dashboard' || interaction.customId === 'return_dashboard') {
        try {
            const mainRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('menu_justice')
                        .setLabel('Tribunal Révolutionnaire')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('⚔️'),
                    new ButtonBuilder()
                        .setCustomId('ordre_drapeau_rouge')
                        .setLabel('Ordre du Drapeau Rouge')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('🎖️'),
                    new ButtonBuilder()
                        .setCustomId('menu_config')
                        .setLabel('Directives du Parti')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('⭐')
                );

            const mainEmbed = new EmbedBuilder()
                .setTitle('⭐ Quartier Général du Parti ⭐')
                .setDescription(
                    '**Camarade Commissaire, bienvenue au QG !**\n\n' +
                    'Choisissez votre département :\n\n' +
                    '⚔️ **Tribunal Révolutionnaire**\n' +
                    '› Justice prolétarienne et discipline révolutionnaire\n\n' +
                    '🎖️ **Ordre du Drapeau Rouge**\n' +
                    '› Décorations et mérites des camarades\n\n' +
                    '⭐ **Directives du Parti**\n' +
                    '› Administration centrale du Parti'
                )
                .setColor('#CC0000')
                .setFooter({ text: 'Prolétaires de tous les serveurs, unissez-vous !' });

            if (interaction.commandName === 'dashboard') {
                await interaction.reply({
                    embeds: [mainEmbed],
                    components: [mainRow],
                    ephemeral: true
                });
            } else {
                await interaction.update({
                    embeds: [mainEmbed],
                    components: [mainRow]
                });
            }
        } catch (error) {
            console.error('Erreur lors de l\'affichage du dashboard:', error);
            const errorMessage = {
                content: '❌ Une erreur s\'est produite lors de l\'affichage du menu.',
                ephemeral: true
            };
            
            if (interaction.commandName === 'dashboard') {
                await interaction.reply(errorMessage);
            } else {
                await interaction.followUp(errorMessage);
            }
        }
    }

    // Menu Configuration
    else if (interaction.customId === 'menu_config') {
        db.get(
            'SELECT mod_role_id, leaderboard_channel_id, welcome_channel_id, leaderboard_time FROM guild_config WHERE guild_id = ?',
            [interaction.guildId],
            async (err, row) => {
                if (err) {
                    console.error('Erreur SQL:', err);
                    return;
                }

                const currentModRole = row?.mod_role_id ? `<@&${row.mod_role_id}>` : 'Non assigné';
                const currentChannel = row?.leaderboard_channel_id ? `<#${row.leaderboard_channel_id}>` : 'Non assigné';
                const welcomeChannel = row?.welcome_channel_id ? `<#${row.welcome_channel_id}>` : 'Non assigné';

                const configEmbed = new EmbedBuilder()
                    .setTitle('⚙️ Directives du Parti')
                    .setDescription('Configuration du système')
                    .setColor('#CC0000');

                if (row?.mod_role_id) {
                    const role = interaction.guild.roles.cache.get(row.mod_role_id);
                    configEmbed.addFields({
                        name: '🛠️ Garde Rouge',
                        value: role ? `Rôle actuel : ${role}` : 'Rôle non trouvé'
                    });
                }

                if (row?.leaderboard_channel_id) {
                    const channel = interaction.guild.channels.cache.get(row.leaderboard_channel_id);
                    configEmbed.addFields({
                        name: '📢 Canal de Propagande',
                        value: channel ? `Canal actuel : ${channel}` : 'Canal non trouvé'
                    });
                }

                if (row?.welcome_channel_id) {
                    const channel = interaction.guild.channels.cache.get(row.welcome_channel_id);
                    configEmbed.addFields({
                        name: '🚩 Canal d\'Accueil',
                        value: channel ? `Canal actuel : ${channel}` : 'Canal non trouvé'
                    });
                }

                if (row?.leaderboard_time) {
                    configEmbed.addFields({
                        name: '⏰ Heure d\'envoi du Classement',
                        value: `Configuration actuelle : ${row.leaderboard_time || DEFAULT_LEADERBOARD_TIME}`
                    });
                }

                const row1 = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('config_mod_role')
                            .setLabel('Garde Rouge')
                            .setStyle(ButtonStyle.Danger)
                            .setEmoji('🛠️'),
                        new ButtonBuilder()
                            .setCustomId('config_leaderboard')
                            .setLabel('Canal de Propagande')
                            .setStyle(ButtonStyle.Primary)
                            .setEmoji('📢'),
                        new ButtonBuilder()
                            .setCustomId('config_welcome_channel')
                            .setLabel('Canal d\'Accueil')
                            .setStyle(ButtonStyle.Primary)
                            .setEmoji('🚩')
                    );

                const row2 = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('welcome_config')
                            .setLabel('Message d\'Accueil')
                            .setStyle(ButtonStyle.Primary)
                            .setEmoji('📨'),
                        new ButtonBuilder()
                            .setCustomId('config_leaderboard_time')
                            .setLabel('Heure du Classement')
                            .setStyle(ButtonStyle.Primary)
                            .setEmoji('⏰')
                    );

                const row3 = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('config_recipients')
                            .setLabel('Destinataires Rapports')
                            .setStyle(ButtonStyle.Primary)
                            .setEmoji('📬'),
                        new ButtonBuilder()
                            .setCustomId('return_dashboard')
                            .setLabel('Retour')
                            .setStyle(ButtonStyle.Secondary)
                            .setEmoji('↩️')
                    );

                await interaction.update({
                    embeds: [configEmbed],
                    components: [row1, row2, row3]
                });
            }
        );
    }

    // Configuration de l'heure d'envoi du classement
    else if (interaction.customId === 'config_leaderboard_time') {
        try {
            // Créer le modal
            const modal = new ModalBuilder()
                .setCustomId('leaderboard_time_modal')
                .setTitle('⏰ Configuration de l\'Heure d\'Envoi');

            const timeInput = new TextInputBuilder()
                .setCustomId('cron_expression')
                .setLabel('Expression Cron')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('0 0 * * 0')
                .setValue(DEFAULT_LEADERBOARD_TIME)
                .setRequired(true);

            const helpText = new TextInputBuilder()
                .setCustomId('help_text')
                .setLabel('Format')
                .setStyle(TextInputStyle.Paragraph)
                .setValue('Format: minute heure * * jour\nExemples:\n0 0 * * 0 = Dimanche à minuit\n0 20 * * 0 = Dimanche à 20h00')
                .setRequired(false);

            const row1 = new ActionRowBuilder().addComponents(timeInput);
            const row2 = new ActionRowBuilder().addComponents(helpText);

            modal.addComponents(row1, row2);

            await interaction.showModal(modal);
        } catch (error) {
            console.error('Erreur lors de l\'affichage du modal:', error);
            await interaction.update({
                content: '❌ Une erreur s\'est produite lors de la configuration.',
                ephemeral: true
            });
        }
    }

    // Traitement du modal de configuration de l'heure
    else if (interaction.customId === 'leaderboard_time_modal') {
        try {
            const cronExpression = interaction.fields.getTextInputValue('cron_expression');

            // Vérifier si l'expression cron est valide
            try {
                new cron.schedule(cronExpression, () => {});
            } catch (error) {
                await interaction.update({
                    content: '❌ Expression cron invalide. Veuillez utiliser un format valide (ex: 0 0 * * 0)',
                    ephemeral: true
                });
                return;
            }

            // Sauvegarder dans la base de données
            db.run(
                'INSERT INTO guild_config (guild_id, leaderboard_time) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET leaderboard_time = excluded.leaderboard_time',
                [interaction.guildId, cronExpression],
                async (err) => {
                    if (err) {
                        console.error('Erreur SQL:', err);
                        await interaction.update({
                            content: '❌ Une erreur s\'est produite lors de la sauvegarde.',
                            ephemeral: true
                        });
                        return;
                    }

                    // Mettre à jour le planning
                    updateLeaderboardSchedule(cronExpression);

                    const embed = new EmbedBuilder()
                        .setTitle('✅ Heure d\'Envoi Configurée')
                        .setDescription(`Le classement sera envoyé selon l'expression : ${cronExpression}`)
                        .setColor('#CC0000')
                        .setFooter({ text: 'Configuration sauvegardée' });

                    const row = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId('menu_config')
                                .setLabel('Retour aux Directives')
                                .setStyle(ButtonStyle.Secondary)
                                .setEmoji('↩️')
                        );

                    await interaction.update({
                        embeds: [embed],
                        components: [row]
                    });
                }
            );
        } catch (error) {
            console.error('Erreur lors du traitement du modal:', error);
            await interaction.update({
                content: '❌ Une erreur s\'est produite lors de la configuration.',
                ephemeral: true
            });
        }
    }

    // Menu Justice
    else if (interaction.customId === 'menu_justice') {
        try {
            // Vérifier le rôle de modérateur
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                const config = await new Promise((resolve, reject) => {
                    db.get('SELECT mod_role_id FROM guild_config WHERE guild_id = ?', 
                        [interaction.guildId], 
                        (err, row) => {
                            if (err) reject(err);
                            else resolve(row);
                        }
                    );
                });

                if (!config?.mod_role_id || !interaction.member.roles.cache.has(config.mod_role_id)) {
                    await interaction.update({
                        content: '❌ Vous n\'avez pas l\'autorisation du Parti pour accéder à ce département !',
                        ephemeral: true
                    });
                    return;
                }
            }

            // Créer le menu de sélection de catégorie
            const categorySelect = new StringSelectMenuBuilder()
                .setCustomId('select_action_category')
                .setPlaceholder('Sélectionner une catégorie')
                .addOptions([
                    {
                        label: 'Modération',
                        description: 'Actions de modération de base',
                        value: 'moderation',
                        emoji: '🛡️'
                    },
                    {
                        label: 'Douane et Accueil',
                        description: 'Actions liées à l\'accueil des nouveaux',
                        value: 'douane',
                        emoji: '🚪'
                    },
                    {
                        label: 'Animation',
                        description: 'Actions d\'animation et événements',
                        value: 'animation',
                        emoji: '🎮'
                    },
                    {
                        label: 'Contenu',
                        description: 'Actions de création de contenu',
                        value: 'contenu',
                        emoji: '🎨'
                    },
                    {
                        label: 'Pédagogie',
                        description: 'Actions pédagogiques',
                        value: 'pedagogie',
                        emoji: '📚'
                    },
                    {
                        label: 'Progression',
                        description: 'Actions de progression',
                        value: 'progression',
                        emoji: '📈'
                    },
                    {
                        label: 'Sécurité',
                        description: 'Actions de sécurité',
                        value: 'securite',
                        emoji: '🔒'
                    },
                    {
                        label: 'Journal',
                        description: 'Actions liées au journal',
                        value: 'journal',
                        emoji: '📰'
                    }
                ]);

            const row1 = new ActionRowBuilder()
                .addComponents(categorySelect);

            const row2 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('show_points_table')
                        .setLabel('Tableau des Points')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('📊'),
                    new ButtonBuilder()
                        .setCustomId('return_dashboard')
                        .setLabel('Retour au QG')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('↩️')
                );

            const embed = new EmbedBuilder()
                .setTitle('⚖️ Département de la Justice ⚖️')
                .setDescription('Sélectionnez une catégorie d\'action à déclarer.')
                .setColor('#CC0000')
                .setFooter({ text: 'Le Parti observe vos actions avec attention !' });

            await interaction.update({
                embeds: [embed],
                components: [row1, row2]
            });

        } catch (error) {
            console.error('Erreur lors de l\'affichage du menu justice:', error);
            await interaction.update({
                content: '❌ Une erreur s\'est produite lors de l\'affichage du menu.',
                ephemeral: true
            });
        }
    }

    // Sélection de la catégorie d'action
    else if (interaction.customId === 'select_action_category') {
        const category = interaction.values[0];
        
        try {
            // Filtrer les actions par catégorie
            const categoryActions = {
                moderation: ['WARN', 'MUTE', 'KICK', 'BAN', 'DELETE', 'TIMEOUT'],
                douane: ['CONTROLE_DOUANE', 'EXPULSION_CENTRE', 'ACCUEIL_SIMPLE', 'ACCUEIL_SUIVI', 'REATTRIBUTION_NUMERO'],
                animation: ['DEBAT', 'DEBAT_ACTIF', 'SONDAGE', 'CONCOURS', 'EVENT', 'VOCAL'],
                contenu: ['MEME', 'MEME_VALIDE', 'VIDEO', 'REPOST'],
                pedagogie: ['FICHE_PRISONNIER', 'COURS', 'APPRENTISSAGE', 'EVOLUTION_NOTE'],
                progression: ['ETAPE_AUTONOMIE', 'PUBLICATION_SOCIALE'],
                securite: ['LISTE_SUSPECT', 'PREUVE_SUSPICION', 'ARRET_INTRUS'],
                journal: ['ARTICLE', 'INTERVIEW']
            };

            const actions = categoryActions[category];
            if (!actions) {
                await interaction.update({
                    content: '❌ Catégorie invalide.',
                    ephemeral: true
                });
                return;
            }

            // Créer le menu de sélection d'action pour cette catégorie
            const actionSelect = new StringSelectMenuBuilder()
                .setCustomId('select_action_type')
                .setPlaceholder('Sélectionner une action')
                .addOptions(
                    actions.map(action => ({
                        label: CONFIG.ACTIONS[action].description,
                        description: `${CONFIG.ACTIONS[action].xp} points de mérite`,
                        value: action
                    }))
                );

            const row1 = new ActionRowBuilder()
                .addComponents(actionSelect);

            const row2 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('menu_justice')
                        .setLabel('Retour aux catégories')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('↩️')
                );

            const embed = new EmbedBuilder()
                .setTitle('📝 Sélection de l\'Action')
                .setDescription('Sélectionnez l\'action spécifique à déclarer.')
                .setColor('#CC0000')
                .setFooter({ text: 'Le Parti demande des comptes !' });

            await interaction.update({
                embeds: [embed],
                components: [row1, row2]
            });

        } catch (error) {
            console.error('Erreur lors de la sélection de la catégorie:', error);
            await interaction.update({
                content: '❌ Une erreur s\'est produite lors de la sélection de la catégorie.',
                ephemeral: true
            });
        }
    }

    // Affichage du tableau des points
    else if (interaction.customId === 'show_points_table') {
        try {
            // Vérifier si c'est un admin
            const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);

            // Créer le tableau des points par catégorie
            const categories = {
                'Modération': ['WARN', 'MUTE', 'KICK', 'BAN', 'DELETE', 'TIMEOUT'],
                'Douane et Accueil': ['CONTROLE_DOUANE', 'EXPULSION_CENTRE', 'ACCUEIL_SIMPLE', 'ACCUEIL_SUIVI', 'REATTRIBUTION_NUMERO'],
                'Animation': ['DEBAT', 'DEBAT_ACTIF', 'SONDAGE', 'CONCOURS', 'EVENT', 'VOCAL'],
                'Contenu': ['MEME', 'MEME_VALIDE', 'VIDEO', 'REPOST'],
                'Pédagogie': ['FICHE_PRISONNIER', 'COURS', 'APPRENTISSAGE', 'EVOLUTION_NOTE'],
                'Progression': ['ETAPE_AUTONOMIE', 'PUBLICATION_SOCIALE'],
                'Sécurité': ['LISTE_SUSPECT', 'PREUVE_SUSPICION', 'ARRET_INTRUS'],
                'Journal': ['ARTICLE', 'INTERVIEW']
            };

            let description = '**🔄 Conversion PMR en XP**\n';
            description += '1 PMR = 1 XP\n\n';

            for (const [category, actions] of Object.entries(categories)) {
                description += `\n**${category}**\n`;
                for (const action of actions) {
                    const pmr = CONFIG.ACTIONS[action].xp;
                    const xp = pmr; // 1 PMR = 1 XP
                    description += `› ${CONFIG.ACTIONS[action].description}: ${pmr} PMR (${xp} XP)\n`;
                }
            }

            description += '\n**Points par Message**\n';
            description += `› Message normal: ${CONFIG.XP_PAR_MESSAGE} PMR (${CONFIG.XP_PAR_MESSAGE} XP)\n`;
            description += `› Multiplicateur: ${CONFIG.XP_MULTIPLICATEUR}x\n`;
            description += `› Cooldown: ${CONFIG.COOLDOWN / 1000} secondes\n`;

            const embed = new EmbedBuilder()
                .setTitle('📊 Tableau des Points de Mérite Révolutionnaire')
                .setDescription(description)
                .setColor('#CC0000')
                .setFooter({ text: isAdmin ? 'Utilisez le bouton ci-dessous pour modifier les points' : 'Le Parti définit la valeur de vos actions !' });

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('menu_justice')
                        .setLabel('Retour aux catégories')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('↩️')
                );

            // Ajouter le bouton de modification pour les admins
            if (isAdmin) {
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId('modify_points')
                        .setLabel('Modifier les Points')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('✏️')
                );
            }

            await interaction.update({
                embeds: [embed],
                components: [row]
            });

        } catch (error) {
            console.error('Erreur lors de l\'affichage du tableau des points:', error);
            await interaction.update({
                content: '❌ Une erreur s\'est produite lors de l\'affichage du tableau.',
                ephemeral: true
            });
        }
    }

    // Modal de modification des points
    else if (interaction.customId === 'modify_points') {
        try {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                await interaction.update({
                    content: '❌ Seuls les administrateurs peuvent modifier les points.',
                    ephemeral: true
                });
                return;
            }

            const modal = new ModalBuilder()
                .setCustomId('points_config_modal')
                .setTitle('Configuration des Points');

            const xpPerMessageInput = new TextInputBuilder()
                .setCustomId('xp_per_message')
                .setLabel('Points par message')
                .setStyle(TextInputStyle.Short)
                .setValue(CONFIG.XP_PAR_MESSAGE.toString())
                .setRequired(true);

            const xpMultiplierInput = new TextInputBuilder()
                .setCustomId('xp_multiplier')
                .setLabel('Multiplicateur (ex: 1.5)')
                .setStyle(TextInputStyle.Short)
                .setValue(CONFIG.XP_MULTIPLICATEUR.toString())
                .setRequired(true);

            const cooldownInput = new TextInputBuilder()
                .setCustomId('cooldown')
                .setLabel('Cooldown en secondes')
                .setStyle(TextInputStyle.Short)
                .setValue((CONFIG.COOLDOWN / 1000).toString())
                .setRequired(true);

            const row1 = new ActionRowBuilder().addComponents(xpPerMessageInput);
            const row2 = new ActionRowBuilder().addComponents(xpMultiplierInput);
            const row3 = new ActionRowBuilder().addComponents(cooldownInput);

            modal.addComponents(row1, row2, row3);

            await interaction.showModal(modal);

        } catch (error) {
            console.error('Erreur lors de l\'affichage du modal de configuration:', error);
            await interaction.update({
                content: '❌ Une erreur s\'est produite lors de la modification des points.',
                ephemeral: true
            });
        }
    }

    // Traitement du modal de configuration des points
    else if (interaction.customId === 'points_config_modal') {
        try {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                await interaction.reply({
                    content: '❌ Seuls les administrateurs peuvent modifier les points.',
                    ephemeral: true
                });
                return;
            }

            const xpPerMessage = parseFloat(interaction.fields.getTextInputValue('xp_per_message'));
            const xpMultiplier = parseFloat(interaction.fields.getTextInputValue('xp_multiplier'));
            const cooldown = parseInt(interaction.fields.getTextInputValue('cooldown')) * 1000;

            if (isNaN(xpPerMessage) || isNaN(xpMultiplier) || isNaN(cooldown)) {
                await interaction.reply({
                    content: '❌ Les valeurs entrées ne sont pas valides.',
                    ephemeral: true
                });
                return;
            }

            // Mettre à jour la configuration
            CONFIG.XP_PAR_MESSAGE = xpPerMessage;
            CONFIG.XP_MULTIPLICATEUR = xpMultiplier;
            CONFIG.COOLDOWN = cooldown;

            await interaction.reply({
                content: '✅ Configuration mise à jour avec succès !',
                ephemeral: true
            });

        } catch (error) {
            console.error('Erreur lors de la mise à jour de la configuration:', error);
            await interaction.reply({
                content: '❌ Une erreur s\'est produite lors de la mise à jour.',
                ephemeral: true
            });
        }
    }

    // Déclaration d'action
    else if (interaction.customId === 'declarer_action') {
        // Vérifier le rôle de modérateur
        const hasModRole = await checkModRole(interaction);
        if (!hasModRole) return;

        const actionSelect = new StringSelectMenuBuilder()
            .setCustomId('select_action_type')
            .setPlaceholder('Type d\'action')
            .addOptions(
                Object.entries(CONFIG.ACTIONS).map(([key, value]) => ({
                    label: value.description,
                    description: `${value.xp} points de mérite`,
                    value: key
                }))
            );

        const row = new ActionRowBuilder()
            .addComponents(actionSelect);

        const embed = new EmbedBuilder()
            .setTitle('📝 Déclaration d\'Action')
            .setDescription('Sélectionnez le type d\'action que vous avez effectué.')
            .setColor('#CC0000')
            .setFooter({ text: 'Le Parti vous remercie de votre vigilance' });

        try {
            await interaction.update({
                embeds: [embed],
                components: [row]
            });
        } catch (error) {
            if (error.code === 10062) {
                await interaction.reply({
                    embeds: [embed],
                    components: [row],
                    ephemeral: true
                });
            } else {
                throw error;
            }
        }
    }

    // Sélection du type d'action
    else if (interaction.customId === 'select_action_type') {
        const actionType = interaction.values[0];

        try {
            // Vérifier si l'action existe
            if (!CONFIG.ACTIONS[actionType]) {
                await interaction.update({
                    content: '❌ Cette action n\'existe pas dans la configuration.',
                    ephemeral: true
                });
                return;
            }

            // Créer un menu pour sélectionner l'utilisateur
            const userSelect = new UserSelectMenuBuilder()
                .setCustomId(`select_user_${actionType}`)
                .setPlaceholder('Sélectionner un utilisateur');

            const row = new ActionRowBuilder()
                .addComponents(userSelect);

            const embed = new EmbedBuilder()
                .setTitle('👤 Sélection de l\'Utilisateur')
                .setDescription('Sélectionnez l\'utilisateur concerné par cette action.')
                .setColor('#CC0000')
                .setFooter({ text: 'Le Parti demande des comptes !' });

            await interaction.update({
                embeds: [embed],
                components: [row]
            });
        } catch (error) {
            console.error('Erreur lors de la sélection de l\'utilisateur:', error);
            await interaction.update({
                content: '❌ Une erreur s\'est produite lors de la sélection de l\'utilisateur.',
                ephemeral: true
            });
        }
    }

    // Sélection de l'utilisateur
    else if (interaction.customId.startsWith('select_user_')) {
        try {
            const actionType = interaction.customId.replace('select_user_', '');

            // Créer le modal pour les détails
            const modal = new ModalBuilder()
                .setCustomId(`action_details_${actionType}`)
                .setTitle('Rapport d\'Action');

            // Champ pour l'utilisateur ciblé
            const userInput = new TextInputBuilder()
                .setCustomId('target_user')
                .setLabel('ID de l\'utilisateur')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Collez l\'ID ou le @mention de l\'utilisateur')
                .setRequired(true);

            // Champ pour la raison
            const reasonInput = new TextInputBuilder()
                .setCustomId('reason')
                .setLabel('Raison de l\'action')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Expliquez pourquoi cette action est nécessaire')
                .setRequired(true);

            // Champ pour les preuves (optionnel)
            const evidenceInput = new TextInputBuilder()
                .setCustomId('evidence')
                .setLabel('Preuves (optionnel)')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Liens vers des messages, captures d\'écran, etc.')
                .setRequired(false);

            const firstRow = new ActionRowBuilder().addComponents(userInput);
            const secondRow = new ActionRowBuilder().addComponents(reasonInput);
            const thirdRow = new ActionRowBuilder().addComponents(evidenceInput);

            modal.addComponents(firstRow, secondRow, thirdRow);

            await interaction.showModal(modal);
        } catch (error) {
            console.error('Erreur lors de l\'affichage du modal:', error);
            try {
                await interaction.update({
                    content: '❌ Une erreur s\'est produite. Veuillez réessayer via le menu Justice.',
                    ephemeral: true
                });
            } catch (replyError) {
                console.error('Erreur lors de la réponse d\'erreur:', replyError);
            }
        }
    }

    // Traitement du rapport d'action
    else if (interaction.isModalSubmit() && interaction.customId.startsWith('action_details_')) {
        try {
            const actionType = interaction.customId.replace('action_details_', '');
            const xpGained = CONFIG.ACTIONS[actionType].xp;
            const weekNumber = getWeekNumber();

            // Récupérer les détails du formulaire
            const targetUser = interaction.fields.getTextInputValue('target_user');
            const reason = interaction.fields.getTextInputValue('reason');
            const evidence = interaction.fields.getTextInputValue('evidence');

            // Enregistrer l'action dans la base de données
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO mod_actions (user_id, guild_id, action_type, xp_gained, week_number) VALUES (?, ?, ?, ?, ?)',
                    [interaction.user.id, interaction.guildId, actionType, xpGained, weekNumber],
                    function(err) {
                        if (err) reject(err);
                        else resolve();
                    }
                );
            });

            // Mettre à jour l'XP
            await new Promise((resolve, reject) => {
                db.run(
                    `INSERT INTO mod_xp (user_id, guild_id, xp, weekly_xp)
                     VALUES (?, ?, ?, ?)
                     ON CONFLICT(user_id, guild_id) DO UPDATE SET
                     xp = xp + ?,
                     weekly_xp = weekly_xp + ?`,
                    [interaction.user.id, interaction.guildId, xpGained, xpGained, xpGained, xpGained],
                    function(err) {
                        if (err) reject(err);
                        else resolve();
                    }
                );
            });

            // Obtenir le total d'XP
            const xpData = await new Promise((resolve, reject) => {
                db.get(
                    'SELECT xp, weekly_xp FROM mod_xp WHERE user_id = ? AND guild_id = ?',
                    [interaction.user.id, interaction.guildId],
                    (err, row) => {
                        if (err) reject(err);
                        else resolve(row);
                    }
                );
            });

            // Créer l'embed de confirmation
            const confirmEmbed = new EmbedBuilder()
                .setTitle('✅ Action Enregistrée')
                .setDescription(
                    `**Action:** ${CONFIG.ACTIONS[actionType].description}\n` +
                    `**Points gagnés:** ${xpGained}\n\n` +
                    `**Total:** ${xpData.xp} points\n` +
                    `**Cette semaine:** ${xpData.weekly_xp} points`
                )
                .setColor('#00CC00')
                .setFooter({ text: 'Gloire aux gardiens de l\'ordre !' });

            // Créer l'embed du rapport
            const reportEmbed = new EmbedBuilder()
                .setTitle('📋 Rapport d\'Action de Modération')
                .setDescription(`Une action de modération a été effectuée par ${interaction.user}.`)
                .addFields(
                    { 
                        name: '🛠️ Type d\'action', 
                        value: CONFIG.ACTIONS[actionType].description 
                    },
                    { 
                        name: '👤 Modérateur', 
                        value: `${interaction.user.tag} (${interaction.user.id})` 
                    },
                    { 
                        name: '🎯 Utilisateur ciblé', 
                        value: targetUser 
                    },
                    { 
                        name: '📝 Raison', 
                        value: reason 
                    }
                )
                .setColor('#CC0000')
                .setTimestamp();

            if (evidence) {
                reportEmbed.addFields({ name: '🔍 Preuves', value: evidence });
            }

            const returnButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('menu_justice')
                        .setLabel('Retour à la Justice')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('↩️')
                );

            // Envoyer la confirmation au modérateur
            await interaction.update({
                embeds: [confirmEmbed],
                components: [returnButton]
            });

            try {
                // Créer un Set pour les destinataires uniques
                const uniqueRecipients = new Set();

                // Récupérer la configuration
                const config = await new Promise((resolve, reject) => {
                    db.get('SELECT mod_role_id FROM guild_config WHERE guild_id = ?', 
                        [interaction.guildId], 
                        (err, row) => {
                            if (err) reject(err);
                            else resolve(row);
                        }
                    );
                });

                console.log('Config récupérée:', config);

                // Ajouter les admins au Set
                if (config?.mod_role_id) {
                    console.log('Role modérateur trouvé:', config.mod_role_id);
                    const admins = interaction.guild.members.cache
                        .filter(member => member.roles.cache.has(config.mod_role_id) && !member.user.bot);
                    
                    console.log('Admins trouvés:', admins.size);
                    admins.forEach(member => {
                        uniqueRecipients.add(member.id);
                        console.log('Admin ajouté:', member.user.tag);
                    });
                } else {
                    console.log('Aucun rôle modérateur configuré');
                }

                // Récupérer et ajouter les destinataires configurés
                const rows = await new Promise((resolve, reject) => {
                    db.all('SELECT user_id FROM report_recipients WHERE guild_id = ?', 
                        [interaction.guildId], 
                        (err, rows) => {
                            if (err) reject(err);
                            else resolve(rows);
                        }
                    );
                });

                console.log('Destinataires configurés trouvés:', rows.length);
                for (const row of rows) {
                    try {
                        const member = await interaction.guild.members.fetch(row.user_id);
                        if (member && !member.user.bot) {
                            uniqueRecipients.add(row.user_id);
                            console.log('Destinataire ajouté:', member.user.tag);
                        }
                    } catch (error) {
                        console.log('Destinataire ignoré (non trouvé):', row.user_id);
                    }
                }

                console.log('Nombre total de destinataires uniques:', uniqueRecipients.size);

                // Envoyer le rapport à chaque destinataire unique
                const failedRecipients = [];

                for (const userId of uniqueRecipients) {
                    try {
                        const recipient = await client.users.fetch(userId);
                        console.log('Tentative d\'envoi à:', recipient.tag);
                        await recipient.send({
                            embeds: [reportEmbed],
                            content: `🚨 Nouvelle action de modération dans ${interaction.guild.name}`
                        });
                        console.log('Message envoyé avec succès à:', recipient.tag);
                    } catch (error) {
                        console.error(`Erreur lors de l'envoi du rapport à ${userId}:`, error);
                        if (error.code === 50007) {
                            failedRecipients.push(userId);
                            try {
                                await new Promise((resolve, reject) => {
                                    db.run('DELETE FROM report_recipients WHERE guild_id = ? AND user_id = ?',
                                        [interaction.guildId, userId],
                                        err => err ? reject(err) : resolve()
                                    );
                                });
                                console.log('Destinataire supprimé car DMs bloqués:', userId);
                            } catch (dbError) {
                                console.error('Erreur lors de la suppression du destinataire:', dbError);
                            }
                        }
                    }
                }

                if (failedRecipients.length > 0) {
                    const errorEmbed = new EmbedBuilder()
                        .setColor('#ff0000')
                        .setTitle('⚠️ Erreur d\'Envoi des Rapports')
                        .setDescription(
                            `Impossible d'envoyer les rapports aux destinataires suivants :\n` +
                            failedRecipients.map(id => `<@${id}>`).join('\n') +
                            '\n\nCause possible : DMs bloqués'
                        )
                        .setTimestamp();

                    try {
                        await interaction.followUp({
                            embeds: [errorEmbed],
                            ephemeral: true
                        });
                    } catch (followUpError) {
                        console.error('Erreur lors de l\'envoi du message d\'erreur:', followUpError);
                    }
                }
            } catch (error) {
                console.error('Erreur lors de l\'envoi des rapports:', error);
            }
        } catch (error) {
            console.error('Erreur lors du traitement du rapport:', error);
            try {
                await interaction.update({
                    content: '❌ Une erreur s\'est produite lors de l\'enregistrement de l\'action. Veuillez réessayer.',
                    ephemeral: true
                });
            } catch (replyError) {
                console.error('Erreur lors de la réponse d\'erreur:', replyError);
            }
        }
    }

    // Retour au menu principal
    else if (interaction.customId === 'return_dashboard') {
        try {
            const mainEmbed = new EmbedBuilder()
                .setTitle('☭ Quartier Général du Parti ☭')
                .setDescription(
                    '**Camarade Commissaire, bienvenue au QG !**\n\n' +
                    'Choisissez votre département :\n\n' +
                    '⚔️ **Tribunal Révolutionnaire**\n' +
                    '› Justice prolétarienne et discipline révolutionnaire\n\n' +
                    '🎖️ **Ordre du Drapeau Rouge**\n' +
                    '› Décorations et mérites des camarades\n\n' +
                    '⭐ **Directives du Parti**\n' +
                    '› Administration centrale du Parti'
                )
                .setColor('#CC0000')
                .setFooter({ text: 'Prolétaires de tous les serveurs, unissez-vous !' });

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('menu_justice')
                        .setLabel('Tribunal Révolutionnaire')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('⚔️'),
                    new ButtonBuilder()
                        .setCustomId('ordre_drapeau_rouge')
                        .setLabel('Ordre du Drapeau Rouge')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('🎖️'),
                    new ButtonBuilder()
                        .setCustomId('menu_config')
                        .setLabel('Directives du Parti')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('⚙️')
                );

            await interaction.update({ embeds: [mainEmbed], components: [row] });
        } catch (error) {
            console.error('Erreur lors du retour au menu principal:', error);
        }
    }

    // Menu configuration
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
                            .setEmoji('☭'),
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
                            .setCustomId('config_recipients')
                            .setLabel('Destinataires Rapports')
                            .setStyle(ButtonStyle.Primary)
                            .setEmoji('📬'),
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
                        `☭ **Garde Rouge** - ${currentModRole}\n` +
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
                    await interaction.update({
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

                await interaction.update({ 
                    embeds: [embed], 
                    components: [returnButton]
                });
            });
        });
    }

    // Sélection du canal de tableau d'honneur
    else if (interaction.customId === 'select_leaderboard_channel') {
        const channelId = interaction.values[0];
        
        db.run(
            `INSERT INTO guild_config (guild_id, leaderboard_channel_id) 
             VALUES (?, ?)
             ON CONFLICT(guild_id) 
             DO UPDATE SET leaderboard_channel_id = ?
             WHERE guild_id = ?`,
            [interaction.guildId, channelId, channelId, interaction.guildId],
            async err => {
                if (err) {
                    console.error('Erreur SQL:', err);
                    await interaction.update({
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

                await interaction.update({ 
                    embeds: [embed], 
                    components: [returnButton]
                });
            }
        );
    }

    // Sélection du salon de bienvenue
    else if (interaction.customId === 'select_welcome_channel') {
        const channelId = interaction.values[0];
        
        db.run(
            `INSERT INTO guild_config (guild_id, welcome_channel_id) 
             VALUES (?, ?)
             ON CONFLICT(guild_id) 
             DO UPDATE SET welcome_channel_id = ?
             WHERE guild_id = ?`,
            [interaction.guildId, channelId, channelId, interaction.guildId],
            async err => {
                if (err) {
                    console.error('Erreur SQL:', err);
                    await interaction.update({
                        content: '❌ Une erreur s\'est produite lors de la configuration du canal !',
                        ephemeral: true
                    });
                    return;
                }

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

                await interaction.update({ 
                    embeds: [embed], 
                    components: [returnButton]
                });
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
            .setDescription('Configurez le message qui accueillera les nouveaux camarades :\n\n' +
                '**Variables disponibles :**\n' +
                '`{user}` - Mention du nouveau membre\n' +
                '`{server}` - Nom du serveur\n' +
                '`{memberCount}` - Nombre total de membres')
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
                .setRequired(true);

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
            await interaction.update({ 
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

            // Mettre à jour la configuration
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
                    await interaction.update({ 
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

                await interaction.update({
                    embeds: [embed],
                    components: [row]
                });

            });
        } catch (error) {
            console.error('Erreur lors du traitement du modal:', error);
            await interaction.update({ 
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
                    interaction.update({ 
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
                                await interaction.update({ 
                                    content: '❌ Une erreur s\'est produite !', 
                                    ephemeral: true 
                                });
                                return;
                            }

                            const embed = new EmbedBuilder()
                                .setTitle('✅ Image de Bienvenue Configurée')
                                .setDescription('L\'image a été enregistrée avec succès !')
                                .setColor('#CC0000');

                            await interaction.update({ embeds: [embed] });
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
                                await interaction.update({ 
                                    content: '❌ Une erreur s\'est produite !', 
                                    ephemeral: true 
                                });
                                return;
                            }

                            const embed = new EmbedBuilder()
                                .setTitle('✅ Image de Bienvenue Configurée')
                                .setDescription('L\'image a été enregistrée avec succès !')
                                .setColor('#CC0000');

                            await interaction.update({ embeds: [embed] });
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
                    await interaction.update({
                        content: '❌ Aucune configuration trouvée !',
                        ephemeral: true
                    });
                    return;
                }

                const title = (row.welcome_title?.replace('{user}', interaction.user.username)
                    .replace('{server}', interaction.guild.name)
                    .replace('{memberCount}', interaction.guild.memberCount) || `☭ Bienvenue au Parti, Camarade ${interaction.user.username} ! ☭`);

                const content = (row.welcome_content?.replace('{user}', `<@${interaction.user.id}>`)
                    .replace('{server}', interaction.guild.name)
                    .replace('{memberCount}', interaction.guild.memberCount) ||
                    `Le Parti accueille chaleureusement <@${interaction.user.id}> dans nos rangs !\nTu es notre ${interaction.guild.memberCount}ème camarade.`);

                const embed = new EmbedBuilder()
                    .setTitle(title)
                    .setDescription(content)
                    .setColor('#CC0000');

                if (row.welcome_image) {
                    embed.setImage(row.welcome_image);
                }

                await interaction.update({ 
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
                'Bienvenue au Bureau Politique, Camarade.\n\n' +
                'Sélectionnez votre département :\n\n' +
                '🛡️ **Justice du Parti** - Gestion de la modération\n' +
                '📊 **Médailles du Mérite** - Statistiques et XP\n' +
                '⚙️ **Directives du Parti** - Configuration'
            )
            .setColor('#CC0000')
            .setFooter({ text: 'Pour la gloire de la Révolution !' });

        await interaction.update({ embeds: [mainEmbed], components: [mainRow] });
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
                        await interaction.update({
                            content: '❌ Une erreur s\'est produite !',
                            ephemeral: true
                        });
                        return;
                    }

                    const embed = new EmbedBuilder()
                        .setTitle('✅ Configuration Mise à Jour')
                        .setDescription(`Le rôle Garde Rouge a été défini avec l'ID: ${roleId}`)
                        .setColor('#CC0000');

                    await interaction.update({ embeds: [embed] });
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
                        await interaction.update({
                            content: '❌ Une erreur s\'est produite !',
                            ephemeral: true
                        });
                        return;
                    }

                    const embed = new EmbedBuilder()
                        .setTitle('✅ Configuration Mise à Jour')
                        .setDescription(`Le Canal des Héros a été défini avec l'ID: ${channelId}`)
                        .setColor('#CC0000');

                    await interaction.update({ embeds: [embed] });
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
            .setDescription('Sélectionnez les mesures disciplinaires à appliquer.')
            .setThumbnail(user.displayAvatarURL())
            .setColor('#CC0000')
            .setFooter({ text: 'La justice du Parti est implacable !' });

        await interaction.update({
            embeds: [embed],
            components: [row, row2]
        });
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
            await interaction.update({
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
            const xp = CONFIG.ACTIONS[action.toUpperCase()].xp;
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
            .setTitle('🛠️ Tableau d\'Honneur du Parti 🛠️')
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
                await interaction.update({
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
                        `**Points de Mérite Total :** ${xp}\n` +
                        `**Cette Semaine :** ${weeklyXp}\n\n` +
                        '_"De chacun selon ses capacités, à chacun selon ses mérites."_'
                    )
                    .setColor('#CC0000')
                    .setFooter({ text: 'PMR = Points de Mérite Révolutionnaire' });

                await interaction.update({ embeds: [embed], components: [row1] });
            }
        );
    }

    // Gestion des destinataires
    else if (interaction.customId === 'config_recipients') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            await interaction.update({
                content: '❌ Seuls les administrateurs peuvent configurer les destinataires des rapports.',
                ephemeral: true,
                components: []
            });
            return;
        }

        try {
            const rows = await new Promise((resolve, reject) => {
                db.all('SELECT user_id FROM report_recipients WHERE guild_id = ?', [interaction.guildId], (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                });
            });

            const recipientsEmbed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('📬 Liste des Destinataires des Rapports')
                .setDescription(rows.length > 0 
                    ? rows.map(row => `<@${row.user_id}>`).join('\n')
                    : 'Aucun destinataire configuré');

            const row = new ActionRowBuilder()
                .addComponents(
                    new UserSelectMenuBuilder()
                        .setCustomId('select_recipient')
                        .setPlaceholder('Sélectionner un destinataire')
                        .setMinValues(1)
                        .setMaxValues(1)
                );

            const buttonRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('view_recipients')
                        .setLabel('Voir les Destinataires')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('👥'),
                    new ButtonBuilder()
                        .setCustomId('remove_recipients')
                        .setLabel('Retirer des Destinataires')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('🗑️'),
                    new ButtonBuilder()
                        .setCustomId('return_config')
                        .setLabel('Retour')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('↩️')
                );

            await interaction.update({ embeds: [recipientsEmbed], components: [row, buttonRow], ephemeral: true });
        } catch (error) {
            console.error('Erreur lors de la récupération des destinataires:', error);
            await interaction.update({
                content: '❌ Une erreur s\'est produite lors de la récupération des destinataires.',
                ephemeral: true,
                components: []
            });
        }
    }

    // Gestion de la sélection d'un destinataire
    else if (interaction.customId === 'select_recipient') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            await interaction.update({
                content: '❌ Seuls les administrateurs peuvent ajouter des destinataires.',
                ephemeral: true,
                components: []
            });
            return;
        }

        const userId = interaction.values[0];
        
        try {
            await new Promise((resolve, reject) => {
                db.run('INSERT OR IGNORE INTO report_recipients (guild_id, user_id) VALUES (?, ?)',
                    [interaction.guildId, userId],
                    err => err ? reject(err) : resolve()
                );
            });

            const returnButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('config_recipients')
                        .setLabel('Retour aux Destinataires')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('↩️')
                );

            const successEmbed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('✅ Destinataire Ajouté')
                .setDescription(`<@${userId}> recevra désormais les rapports de modération.`)
                .setTimestamp();

            await interaction.update({
                embeds: [successEmbed],
                components: [returnButton],
                ephemeral: true
            });

        } catch (error) {
            console.error('Erreur lors de l\'ajout du destinataire:', error);
            await interaction.update({
                content: '❌ Une erreur s\'est produite lors de l\'ajout du destinataire.',
                ephemeral: true,
                components: []
            });
        }
    }

    // Afficher les destinataires actuels
    else if (interaction.customId === 'view_recipients') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            await interaction.update({
                content: '❌ Seuls les administrateurs peuvent voir la liste des destinataires.',
                ephemeral: true,
                components: []
            });
            return;
        }

        try {
            const rows = await new Promise((resolve, reject) => {
                db.all('SELECT user_id FROM report_recipients WHERE guild_id = ?', [interaction.guildId], (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                });
            });

            const recipientsEmbed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('📬 Liste des Destinataires des Rapports')
                .setDescription(rows.length > 0 
                    ? rows.map(row => `<@${row.user_id}>`).join('\n')
                    : 'Aucun destinataire configuré');

            const returnButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('config_recipients')
                        .setLabel('Retour aux Destinataires')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('↩️')
                );

            await interaction.update({ 
                embeds: [recipientsEmbed], 
                components: [returnButton], 
                ephemeral: true 
            });
        } catch (error) {
            console.error('Erreur lors de la récupération des destinataires:', error);
            await interaction.update({
                content: '❌ Une erreur s\'est produite lors de la récupération des destinataires.',
                ephemeral: true,
                components: []
            });
        }
    }

    // Retirer des destinataires
    else if (interaction.customId === 'remove_recipients') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            await interaction.update({
                content: '❌ Seuls les administrateurs peuvent retirer des destinataires.',
                ephemeral: true,
                components: []
            });
            return;
        }

        try {
            const rows = await new Promise((resolve, reject) => {
                db.all('SELECT user_id FROM report_recipients WHERE guild_id = ?', [interaction.guildId], (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                });
            });

            if (rows.length === 0) {
                const returnButton = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('config_recipients')
                            .setLabel('Retour aux Destinataires')
                            .setStyle(ButtonStyle.Secondary)
                            .setEmoji('↩️')
                    );

                const emptyEmbed = new EmbedBuilder()
                    .setColor('#ff0000')
                    .setTitle('❌ Aucun Destinataire')
                    .setDescription('Il n\'y a actuellement aucun destinataire configuré.');

                await interaction.update({
                    embeds: [emptyEmbed],
                    components: [returnButton],
                    ephemeral: true
                });
                return;
            }

            const row = new ActionRowBuilder()
                .addComponents(
                    new UserSelectMenuBuilder()
                        .setCustomId('remove_recipient')
                        .setPlaceholder('Sélectionner un destinataire à retirer')
                );

            const returnButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('config_recipients')
                        .setLabel('Retour aux Destinataires')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('↩️')
                );

            const removeEmbed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('🗑️ Retirer un Destinataire')
                .setDescription('Sélectionnez le destinataire que vous souhaitez retirer de la liste.');

            await interaction.update({
                embeds: [removeEmbed],
                components: [row, returnButton],
                ephemeral: true
            });

        } catch (error) {
            console.error('Erreur lors de la récupération des destinataires:', error);
            await interaction.update({
                content: '❌ Une erreur s\'est produite lors de la récupération des destinataires.',
                ephemeral: true,
                components: []
            });
        }
    }

    // Retirer un destinataire spécifique
    else if (interaction.customId === 'remove_recipient') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            await interaction.update({
                content: '❌ Seuls les administrateurs peuvent retirer des destinataires.',
                ephemeral: true,
                components: []
            });
            return;
        }

        const userId = interaction.values[0];
        
        try {
            await new Promise((resolve, reject) => {
                db.run('DELETE FROM report_recipients WHERE guild_id = ? AND user_id = ?',
                    [interaction.guildId, userId],
                    err => err ? reject(err) : resolve()
                );
            });

            const returnButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('config_recipients')
                        .setLabel('Retour aux Destinataires')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('↩️')
                );

            const successEmbed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('✅ Destinataire Retiré')
                .setDescription(`<@${userId}> ne recevra plus les rapports de modération.`)
                .setTimestamp();

            await interaction.update({
                embeds: [successEmbed],
                components: [returnButton],
                ephemeral: true
            });

        } catch (error) {
            console.error('Erreur lors du retrait du destinataire:', error);
            await interaction.update({
                content: '❌ Une erreur s\'est produite lors du retrait du destinataire.',
                ephemeral: true,
                components: []
            });
        }
    }

    // Retour au menu de configuration
    else if (interaction.customId === 'return_config') {
        try {
            const configRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('config_recipients')
                        .setLabel('Configurer les Destinataires')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('📬'),
        
                    new ButtonBuilder()
                        .setCustomId('return_dashboard')
                        .setLabel('Retour au Tableau de Bord')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('↩️')
                );

            const configEmbed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('⚙️ Configuration du Serveur')
                .setDescription('Sélectionnez une option de configuration :')
                .setTimestamp();

            await interaction.update({
                embeds: [configEmbed],
                components: [configRow],
                ephemeral: true
            });
        } catch (error) {
            console.error('Erreur lors du retour au menu de configuration:', error);
            await interaction.update({
                content: '❌ Une erreur s\'est produite. Veuillez réessayer.',
                ephemeral: true,
                components: []
            });
        }
    }

    // Sélection du rôle de modérateur
    else if (interaction.customId === 'config_mod_role') {
        // Créer le menu de sélection pour le rôle de Garde Rouge
        const roles = await interaction.guild.roles.fetch();
        const selectMenu = new ActionRowBuilder()
            .addComponents(
                new RoleSelectMenuBuilder()
                    .setCustomId('select_mod_role')
                    .setPlaceholder('Sélectionner le rôle de Garde Rouge')
            );

        await interaction.update({
            content: 'Sélectionnez le rôle qui sera désigné comme Garde Rouge :',
            components: [selectMenu],
            ephemeral: true
        });
    }

    // Sélection du canal de propagande
    else if (interaction.customId === 'config_leaderboard') {
        // Créer le menu de sélection pour le canal de propagande
        const channels = interaction.guild.channels.cache.filter(channel => 
            channel.type === ChannelType.GuildText
        );

        const selectMenu = new ActionRowBuilder()
            .addComponents(
                new ChannelSelectMenuBuilder()
                    .setCustomId('select_leaderboard_channel')
                    .setPlaceholder('Sélectionner le canal de propagande')
                    .setChannelTypes(ChannelType.GuildText)
            );

        await interaction.update({
            content: 'Sélectionnez le canal qui servira de canal de propagande :',
            components: [selectMenu],
            ephemeral: true
        });
    }

    // Sélection du canal d'accueil
    else if (interaction.customId === 'config_welcome_channel') {
        // Créer le menu de sélection pour le canal d'accueil
        const channels = interaction.guild.channels.cache.filter(channel => 
            channel.type === ChannelType.GuildText
        );

        const selectMenu = new ActionRowBuilder()
            .addComponents(
                new ChannelSelectMenuBuilder()
                    .setCustomId('select_welcome_channel')
                    .setPlaceholder('Sélectionner le canal d\'accueil')
                    .setChannelTypes(ChannelType.GuildText)
            );

        await interaction.update({
            content: 'Sélectionnez le canal qui servira de canal d\'accueil :',
            components: [selectMenu],
            ephemeral: true
        });
    }

    // Ordre du Drapeau Rouge
    else if (interaction.customId === 'ordre_drapeau_rouge') {
        try {
            // Récupérer le top 50 des utilisateurs par XP
            db.all(
                `SELECT user_id, xp 
                FROM mod_xp 
                WHERE guild_id = ? 
                ORDER BY xp DESC 
                LIMIT 50`,
                [interaction.guildId],
                async (err, rows) => {
                    if (err) {
                        console.error('Erreur lors de la récupération du classement:', err);
                        await interaction.reply({
                            content: '❌ Une erreur s\'est produite lors de la récupération du classement.',
                            ephemeral: true
                        });
                        return;
                    }

                    const rankings = await formatTop5(interaction.guild, rows, 'xp');
                    
                    const embed = new EmbedBuilder()
                        .setColor('#ff0000')
                        .setTitle('🎖️ Ordre du Drapeau Rouge')
                        .setDescription('Les camarades les plus méritants du Parti')
                        .addFields({ name: 'Classement', value: rankings || 'Aucun classement disponible' })
                        .setTimestamp();

                    const row = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId('return_dashboard')
                                .setLabel('Retour')
                                .setStyle(ButtonStyle.Secondary)
                        );

                    await interaction.reply({
                        embeds: [embed],
                        components: [row],
                        ephemeral: true
                    });
                }
            );
        } catch (error) {
            console.error('Erreur lors de l\'affichage du classement:', error);
            await interaction.reply({
                content: '❌ Une erreur s\'est produite lors de l\'affichage du classement.',
                ephemeral: true
            });
        }
    }
});

// Gérer les messages pour l'XP
client.on('messageCreate', async message => {
    if (message.author.bot) return;
    
    const isMod = await isModerateur(message.member);
    if (!isMod) return;

    const now = Date.now();
    const lastMessage = messageCooldowns.get(message.author.id);
    
    if (lastMessage && (now - lastMessage) < CONFIG.COOLDOWN) return;
    
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

        // S'assurer que le cache des membres est à jour
        await member.guild.members.fetch();
        const memberCount = (await member.guild.members.fetch()).size;
        console.log(`Nombre de membres dans ${member.guild.name}: ${memberCount}`);

        // Préparer le titre et le contenu
        const title = (configRow?.welcome_title?.replace('{user}', member.user.username)
            .replace('{server}', member.guild.name)
            .replace('{memberCount}', memberCount) || `☭ Bienvenue au Parti, Camarade ${member.user.username} ! ☭`);

        const content = (configRow?.welcome_content?.replace('{user}', `<@${member.id}>`)
            .replace('{server}', member.guild.name)
            .replace('{memberCount}', memberCount) ||
            `Le Parti accueille chaleureusement <@${member.id}> dans nos rangs !\nTu es notre ${memberCount}ème camarade.`);

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
            const notificationMessage = await welcomeChannel.send({ content: `<@${member.id}>` });
            await notificationMessage.delete();  // Supprimer immédiatement la mention
            await welcomeChannel.send({ embeds: [welcomeEmbed] });
        }
    } catch (error) {
        console.error('Erreur lors de l\'envoi du message de bienvenue:', error);
    }
});

client.login(process.env.TOKEN);

// Fonction pour formater le top 50
async function formatTop5(guild, rankings, field) {
    const top50 = rankings
        .sort((a, b) => b[field] - a[field])
        .slice(0, 50);

    let result = '';
    for (let i = 0; i < top50.length; i++) {
        const user = await guild.members.fetch(top50[i].user_id)
            .then(member => member.user)
            .catch(() => ({ username: 'Utilisateur Inconnu' }));
        
        // Ajouter des emojis spéciaux pour les 3 premiers
        let rank = '';
        if (i === 0) rank = '🥇 ';
        else if (i === 1) rank = '🥈 ';
        else if (i === 2) rank = '🥉 ';
        else rank = `${i + 1}. `;
        
        result += `${rank}${user.username}: ${top50[i][field]} points\n`;
        
        // Ajouter une ligne vide après le top 3 et après chaque groupe de 10
        if (i === 2 || (i + 1) % 10 === 0) {
            result += '\n';
        }
    }
    return result || 'Aucun classement disponible';
}
