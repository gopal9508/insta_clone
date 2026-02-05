// -----------------------------------------------------
// IMPORTS & SETUP
// -----------------------------------------------------
const express = require("express");
const app = express();
const port = 3000;
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");
const db = require("./db"); 
const bcrypt = require("bcryptjs");
const session = require("express-session");
const methodOverride = require("method-override");
const helmet = require("helmet");

// -----------------------------------------------------
// MIDDLEWARE
// -----------------------------------------------------
app.use(helmet());
app.use(methodOverride("_method"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // <<< IMPORTANT: to read JSON bodies (for /api/messages)
app.use(express.static(path.join(__dirname, "public")));

app.use(
    session({
        secret: "yourSecretKey123",
        resave: false,
        saveUninitialized: false,
        cookie: { maxAge: 24 * 60 * 60 * 1000 },
    })
);

// Basic XSS-safe input sanitization
app.use((req, res, next) => {
    if (req.body) {
        for (let key in req.body) {
            if (typeof req.body[key] === "string") {
                req.body[key] = req.body[key]
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;");
            }
        }
    }
    next();
});

// Make session available in all EJS files
app.use((req, res, next) => {
    res.locals.session = req.session;
    next();
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Format timestamp helper
app.locals.formatTime = function (date) {
    const d = new Date(date);
    return d.toLocaleString("en-IN", {
        hour12: true,
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
};


// 🔔 Attach unread notification count to session
app.use((req, res, next) => {
    if (!req.session.user) return next();

    const q = `
        SELECT COUNT(*) AS count
        FROM notifications
        WHERE user_id = ? AND is_read = FALSE
    `;

    db.query(q, [req.session.user.id], (err, rows) => {
        if (!err && rows.length > 0) {
            req.session.user.unreadCount = rows[0].count;
        } else {
            req.session.user.unreadCount = 0;
        }
        next();
    });
});

// -----------------------------------------------------
// FILE UPLOAD
// -----------------------------------------------------
const uploadPath = path.join(__dirname, "public/uploads");

if (!fs.existsSync(uploadPath)) {
    fs.mkdirSync(uploadPath, { recursive: true });
}

// For posts & stories (images OR videos)
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadPath),
    filename: (req, file, cb) =>
        cb(null, Date.now() + "-" + file.originalname),
});

const upload = multer({
    storage,
    limits: {
        fileSize: 20 * 1024 * 1024, // 20 MB for posts/stories
    },
    fileFilter(req, file, cb) {
        const allowed = [
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/jpg",
            "video/mp4",
            "video/webm",
            "video/quicktime",
        ];

        if (!allowed.includes(file.mimetype)) {
            cb(new Error("Only images and videos are allowed"));
        } else {
            cb(null, true);
        }
    },
});

// For profile avatar (images ONLY, 5MB)
const avatarUpload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB avatars
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith("image/")) {
            cb(null, true);
        } else {
            cb(
                new Error("Only image files are allowed for profile picture!"),
                false
            );
        }
    },
});

// -----------------------------------------------------
// LOGIN CHECK
// -----------------------------------------------------
function isLoggedIn(req, res, next) {
    if (!req.session.user) return res.redirect("/login");
    next();
}

// -----------------------------------------------------
// FEED (POSTS + STORIES)
// -----------------------------------------------------



app.get("/posts", isLoggedIn, (req, res, next) => {
    const userId = req.session.user.id;

    const postsQ = `
        SELECT 
            p.*, 
            u.avatar AS user_avatar, 
            u.username,
            (SELECT COUNT(*) FROM likes WHERE post_id = p.id) AS likeCount,
            (SELECT COUNT(*) FROM likes WHERE post_id = p.id AND user_id = ?) AS isLiked
        FROM posts p
        JOIN users u ON p.user_id = u.id
        WHERE p.user_id = ? OR p.user_id IN (
            SELECT following_id FROM followers WHERE follower_id = ?
        )
        ORDER BY p.created_at DESC
    `;

    // show ONE story bubble per user (latest active story)
    const storiesQ = `
        SELECT s.*, u.username, u.avatar
        FROM stories s
        JOIN users u ON s.user_id = u.id
        JOIN (
            SELECT user_id, MAX(created_at) AS latest_created
            FROM stories
            WHERE expires_at > NOW()
            GROUP BY user_id
        ) latest ON latest.user_id = s.user_id AND latest.latest_created = s.created_at
        WHERE s.expires_at > NOW()
        ORDER BY s.created_at DESC
    `;

    db.query(postsQ, [userId, userId, userId], (err, posts) => {
        if (err) return next(err);

        posts.forEach((post) => (post.isLiked = post.isLiked > 0));

        if (posts.length === 0) {
            // No posts, still show stories
            return db.query(storiesQ, (err2, stories) => {
                if (err2) stories = [];
                res.render("posts/index.ejs", {
                    posts,
                    stories,
                    currentPage: 1,
                    totalPages: 1,
                });
            });
        }

        const postIds = posts.map((p) => p.id);

        const mediaQ = `
            SELECT post_id, filename, media_type
            FROM post_media
            WHERE post_id IN (?)
            ORDER BY post_id ASC, filename ASC
        `;

        db.query(mediaQ, [postIds], (err2, mediaRows) => {
            if (err2) mediaRows = [];

            const mediaByPostId = {};
            mediaRows.forEach((m) => {
                if (!mediaByPostId[m.post_id]) mediaByPostId[m.post_id] = [];
                mediaByPostId[m.post_id].push(m);
            });

            posts.forEach((p) => {
                p.media = mediaByPostId[p.id] || [];
            });

            db.query(storiesQ, (err3, stories) => {
                if (err3) stories = [];

                res.render("posts/index.ejs", {
                    posts,
                    stories,
                    currentPage: 1,
                    totalPages: 1,
                });
            });
        });
    });
});

// -----------------------------------------------------
// SEARCH USERS
// -----------------------------------------------------
app.get("/search", isLoggedIn, (req, res, next) => {
    const q = req.query.q;

    if (!q || q.trim() === "") {
        return res.render("search-results.ejs", { users: [], query: "" });
    }

    const searchQuery = `
        SELECT id, username, avatar 
        FROM users 
        WHERE username LIKE ?
    `;

    db.query(searchQuery, [`%${q}%`], (err, users) => {
        if (err) return next(err);

        res.render("search-results.ejs", { users, query: q });
    });
});

// -----------------------------------------------------
// NEW POST PAGE
// -----------------------------------------------------
app.get("/posts/new", isLoggedIn, (req, res) => {
    res.render("posts/new.ejs");
});

// -----------------------------------------------------
// CREATE POST (MULTI-IMAGE / VIDEO SUPPORT)
// -----------------------------------------------------
app.post("/posts", isLoggedIn, upload.array("images", 10), (req, res, next) => {
    const { content } = req.body;
    const user_id = req.session.user.id;
    const username = req.session.user.username;
    const postId = uuidv4();

    if (!content || content.trim().length === 0) {
        return res.render("posts/new.ejs", {
            error: "Content is required",
        });
    }

    const postQuery = `
        INSERT INTO posts (id, username, content, user_id) 
        VALUES (?, ?, ?, ?)
    `;

    db.query(postQuery, [postId, username, content.trim(), user_id], (err) => {
        if (err) return next(err);

        if (req.files && req.files.length > 0) {
            const mediaRows = req.files.map((file) => [
                postId,
                file.filename,
                file.mimetype.startsWith("video") ? "video" : "image",
            ]);

            db.query(
                "INSERT INTO post_media (post_id, filename, media_type) VALUES ?",
                [mediaRows],
                (err2) => {
                    if (err2) return next(err2);
                    res.redirect("/posts");
                }
            );
        } else {
            res.redirect("/posts");
        }
    });
});

// -----------------------------------------------------
// EDIT POST (FORM)
// -----------------------------------------------------
app.get("/posts/:id/edit", isLoggedIn, (req, res, next) => {
    const postId = req.params.id;
    const userId = req.session.user.id;

    db.query("SELECT * FROM posts WHERE id = ?", [postId], (err, rows) => {
        if (err) return next(err);
        if (rows.length === 0) {
            return res
                .status(404)
                .render("error.ejs", { message: "Post not found" });
        }

        const post = rows[0];
        if (post.user_id !== userId) {
            return res
                .status(403)
                .render("error.ejs", { message: "You cannot edit this post" });
        }

        res.render("posts/edit.ejs", { post });
    });
});

// -----------------------------------------------------
// UPDATE POST (ONLY TEXT CONTENT)
// -----------------------------------------------------
app.patch("/posts/:id", isLoggedIn, (req, res, next) => {
    const postId = req.params.id;
    const userId = req.session.user.id;
    const { content } = req.body;

    if (!content || content.trim().length === 0) {
        return res.redirect(`/posts/${postId}/edit`);
    }

    db.query(
        "UPDATE posts SET content = ? WHERE id = ? AND user_id = ?",
        [content.trim(), postId, userId],
        (err, result) => {
            if (err) return next(err);
            if (result.affectedRows === 0) {
                return res
                    .status(403)
                    .render("error.ejs", { message: "You cannot edit this post" });
            }
            res.redirect(`/posts/${postId}`);
        }
    );
});     

// -----------------------------------------------------
// DELETE POST (DELETE MEDIA FILES TOO)
// -----------------------------------------------------
app.delete("/posts/:id", isLoggedIn, (req, res, next) => {
    const postId = req.params.id;
    const userId = req.session.user.id;

    db.query("SELECT * FROM posts WHERE id = ?", [postId], (err, rows) => {
        if (err) return next(err);
        if (rows.length === 0) {
            return res
                .status(404)
                .render("error.ejs", { message: "Post not found" });
        }

        const post = rows[0];
        if (post.user_id !== userId) {
            return res
                .status(403)
                .render("error.ejs", { message: "You cannot delete this post" });
        }

        // Delete all media for this post
        const mediaQ = "SELECT filename FROM post_media WHERE post_id = ?";
        db.query(mediaQ, [postId], (err2, mediaRows) => {
            if (err2) mediaRows = [];

            mediaRows.forEach((m) => {
                const filePath = path.join(uploadPath, m.filename);
                fs.unlink(filePath, () => {});
            });

            // Also delete legacy single image if any
            if (post.image) {
                const imgPath = path.join(uploadPath, post.image);
                fs.unlink(imgPath, () => {});
            }

            db.query("DELETE FROM post_media WHERE post_id = ?", [postId], () => {
                db.query("DELETE FROM posts WHERE id = ?", [postId], (err3) => {
                    if (err3) return next(err3);
                    res.redirect("/posts");
                });
            });
        });
    });
});

// -----------------------------------------------------
// UPLOAD STORY
// -----------------------------------------------------

// -----------------------------------------------------
// UPLOAD STORY
// -----------------------------------------------------
app.post("/story", isLoggedIn, upload.single("storyMedia"), (req, res) => {
    const userId = req.session.user.id;

    if (!req.file) {
        console.log("❌ No file uploaded for story");
        return res.redirect("/posts");
    }

    const id = uuidv4();
    const mediaFile = req.file.filename;
    const mediaType = req.file.mimetype.startsWith("video") ? "video" : "image";

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
        .toISOString()
        .slice(0, 19)
        .replace("T", " ");

    const q = `
        INSERT INTO stories (id, user_id, media, media_type, expires_at)
        VALUES (?, ?, ?, ?, ?)
    `;

    db.query(q, [id, userId, mediaFile, mediaType, expiresAt], (err) => {
        if (err) {
            console.error("❌ Story creation error:", err);
            return res.redirect("/posts");
        }
        res.redirect("/posts");
    });
});


// -----------------------------------------------------
// SHOW STORIES (INSTAGRAM STYLE) - START FROM FIRST STORY
// URL: /story/:userId
// -----------------------------------------------------
// -----------------------------------------------------
// OPEN STORIES (start from first)
// -----------------------------------------------------
app.get("/story/:userId", isLoggedIn, (req, res) => {
    const userId = parseInt(req.params.userId, 10);
    const viewerId = req.session.user.id;

    const q = `
        SELECT 
            s.*, 
            u.username, 
            u.avatar,
            (
                SELECT COUNT(*) 
                FROM story_reactions sr 
                WHERE sr.story_id = s.id
            ) AS reactionCount
        FROM stories s
        JOIN users u ON s.user_id = u.id
        WHERE s.user_id = ?
          AND s.expires_at > NOW()
        ORDER BY s.created_at ASC
    `;

    db.query(q, [userId], (err, stories) => {
        if (err || !stories || stories.length === 0) {
            return res.redirect("/posts");
        }

        const storyIndex = 0;
        const currentStory = stories[storyIndex];

        // ✅ Record view (only if viewer is not owner)
        if (viewerId !== userId) {
            recordStoryView(currentStory.id, viewerId);
        }

        const handleRender = (finalStories) => {
            res.render("story-viewer.ejs", {
                stories: finalStories,
                currentStoryIndex: storyIndex,
                storyUser: {
                    id: userId,
                    username: finalStories[0].username,
                    avatar: finalStories[0].avatar,
                },
            });
        };

        // ✅ Add view count ONLY for owner
        if (viewerId === userId) {
            const ids = stories.map(s => s.id);

            const viewsQ = `
                SELECT story_id, COUNT(*) AS views
                FROM story_views
                WHERE story_id IN (?)
                GROUP BY story_id
            `;

            db.query(viewsQ, [ids], (vErr, rows) => {
                const map = {};
                if (!vErr && rows) {
                    rows.forEach(r => map[r.story_id] = r.views);
                }

                stories.forEach(s => {
                    s.viewCount = map[s.id] || 0;
                });

                handleRender(stories);
            });
        } else {
            handleRender(stories);
        }
    });
});


// -----------------------------------------------------
// SPECIFIC STORY INDEX
// URL: /story/:userId/:storyIndex
// -----------------------------------------------------
// -----------------------------------------------------
// SPECIFIC STORY INDEX
// URL: /story/:userId/:storyIndex
// -----------------------------------------------------
app.get("/story/:userId/:storyIndex", isLoggedIn, (req, res) => {
    const userId = parseInt(req.params.userId, 10);
    const storyIndex = parseInt(req.params.storyIndex, 10);
    const viewerId = req.session.user.id;

    const q = `
        SELECT 
            s.*, 
            u.username, 
            u.avatar,
            (
                SELECT COUNT(*) 
                FROM story_reactions sr 
                WHERE sr.story_id = s.id
            ) AS reactionCount
        FROM stories s
        JOIN users u ON s.user_id = u.id
        WHERE s.user_id = ?
          AND s.expires_at > NOW()
        ORDER BY s.created_at ASC
    `;

    db.query(q, [userId], (err, stories) => {
        if (err || !stories || stories.length === 0) {
            return res.redirect("/posts");
        }

        if (storyIndex < 0 || storyIndex >= stories.length) {
            return res.redirect("/posts");
        }

        const currentStory = stories[storyIndex];

        // ✅ Record view if not owner
        if (viewerId !== userId) {
            recordStoryView(currentStory.id, viewerId);
        }

        const handleRender = (finalStories) => {
            res.render("story-viewer.ejs", {
                stories: finalStories,
                currentStoryIndex: storyIndex,
                storyUser: {
                    id: userId,
                    username: finalStories[0].username,
                    avatar: finalStories[0].avatar,
                },
            });
        };

        // ✅ Owner → attach views
        if (viewerId === userId) {
            const ids = stories.map(s => s.id);

            const viewsQ = `
                SELECT story_id, COUNT(*) AS views
                FROM story_views
                WHERE story_id IN (?)
                GROUP BY story_id
            `;

            db.query(viewsQ, [ids], (vErr, rows) => {
                const map = {};
                if (!vErr && rows) {
                    rows.forEach(r => map[r.story_id] = r.views);
                }

                stories.forEach(s => {
                    s.viewCount = map[s.id] || 0;
                });

                handleRender(stories);
            });
        } else {
            handleRender(stories);
        }
    });
});


// -----------------------------------------------------
// ADD / UPDATE STORY REACTION
// -----------------------------------------------------
app.post("/story/:storyId/react", isLoggedIn, (req, res) => {
    const storyId = req.params.storyId;
    const userId = req.session.user.id;
    const { reaction } = req.body;

    const allowed = ["❤️", "🔥", "😂"];
    if (!allowed.includes(reaction)) {
        return res.json({ ok: false });
    }

    const q = `
        INSERT INTO story_reactions (story_id, user_id, reaction)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE reaction = VALUES(reaction)
    `;

    db.query(q, [storyId, userId, reaction], (err) => {
        if (err) {
            console.error("Reaction error:", err);
            return res.json({ ok: false });
        }
        res.json({ ok: true });
    });
});

// -----------------------------------------------------
// VIEW STORY REACTIONS (OWNER ONLY)
// -----------------------------------------------------
app.get("/story/:storyId/reactions", isLoggedIn, (req, res, next) => {
    const storyId = req.params.storyId;
    const currentUserId = req.session.user.id;

    const ownerQ = `SELECT user_id FROM stories WHERE id = ?`;

    db.query(ownerQ, [storyId], (err, rows) => {
        if (err || rows.length === 0) {
            return res.redirect("/posts");
        }

        // Only owner can view reactions
        if (rows[0].user_id !== currentUserId) {
            return res.redirect("/posts");
        }

        const reactionsQ = `
            SELECT 
                sr.reaction,
                sr.created_at,
                u.username,
                u.avatar
            FROM story_reactions sr
            JOIN users u ON sr.user_id = u.id
            WHERE sr.story_id = ?
            ORDER BY sr.created_at DESC
        `;

        db.query(reactionsQ, [storyId], (err2, reactions) => {
            if (err2) return next(err2);

            res.render("story-reactions.ejs", { reactions });
        });
    });
});

// -----------------------------------------------------
// STORY VIEWERS LIST (OWNER ONLY)
// -----------------------------------------------------
app.get("/stories/:storyId/views", isLoggedIn, (req, res, next) => {
    const storyId = req.params.storyId;
    const currentUserId = req.session.user.id;

    const ownerQ = `
        SELECT user_id
        FROM stories
        WHERE id = ?
    `;

    db.query(ownerQ, [storyId], (err, rows) => {
        if (err || rows.length === 0) {
            return res.redirect("/posts");
        }

        if (rows[0].user_id !== currentUserId) {
            return res.redirect("/posts");
        }

        const viewersQ = `
            SELECT u.id, u.username, u.avatar, sv.viewed_at
            FROM story_views sv
            JOIN users u ON u.id = sv.viewer_id
            WHERE sv.story_id = ?
            ORDER BY sv.viewed_at DESC
        `;

        db.query(viewersQ, [storyId], (err2, viewers) => {
            if (err2) return next(err2);

            res.render("story-views.ejs", { viewers });
        });
    });
});


// -----------------------------------------------------
// STORY VIEW HELPER
// -----------------------------------------------------
function recordStoryView(storyId, viewerId) {
    if (!storyId || !viewerId) return;

    const q = `
        INSERT INTO story_views (story_id, viewer_id)
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE viewed_at = CURRENT_TIMESTAMP
    `;

    db.query(q, [storyId, viewerId], (err) => {
        if (err) {
            console.error("Story view insert error:", err);
        }
    });
}


// -----------------------------------------------------
// DEBUG: SEE ACTIVE STORIES
// -----------------------------------------------------
app.get("/debug/stories", isLoggedIn, (req, res) => {
    const q = `
        SELECT id, user_id, media, media_type, expires_at
        FROM stories
        WHERE expires_at > NOW()
    `;
    db.query(q, (err, stories) => {
        if (err) {
            console.error("Debug error:", err);
            return res.json({ error: err.message });
        }
        res.json(stories);
    });
});

// -----------------------------------------------------
// SHOW SINGLE POST (WITH MEDIA + COMMENTS)
// -----------------------------------------------------
app.get("/posts/:id", (req, res, next) => {
    const postId = req.params.id;
    const userId = req.session.user ? req.session.user.id : 0;

    const postQ = `
        SELECT 
            p.*, 
            u.avatar AS user_avatar, 
            u.username,
            (SELECT COUNT(*) FROM likes WHERE post_id = p.id) AS likeCount,
            (SELECT COUNT(*) FROM likes WHERE post_id = p.id AND user_id = ?) AS isLiked
        FROM posts p
        JOIN users u ON p.user_id = u.id
        WHERE p.id = ?
    `;

    const mediaQ = `
        SELECT filename, media_type
        FROM post_media
        WHERE post_id = ?
        ORDER BY filename ASC
    `;

    const commentQ = `
        SELECT comments.*, users.username, users.avatar
        FROM comments
        JOIN users ON comments.user_id = users.id
        WHERE post_id = ?
        ORDER BY comments.created_at ASC
    `;

    db.query(postQ, [userId, postId], (err, postRes) => {
        if (err) return next(err);
        if (postRes.length === 0) {
            return res
                .status(404)
                .render("error.ejs", { message: "Post not found" });
        }

        const post = postRes[0];
        post.isLiked = post.isLiked > 0;

        db.query(mediaQ, [postId], (err2, mediaRows) => {
            if (err2) mediaRows = [];
            post.media = mediaRows;

            db.query(commentQ, [postId], (err3, commentsRes) => {
                if (err3) commentsRes = [];

                res.render("posts/show.ejs", {
                    post,
                    comments: commentsRes,
                });
            });
        });
    });
});

// -----------------------------------------------------
// LIKE / UNLIKE POST
// -----------------------------------------------------
app.post("/posts/:id/like", isLoggedIn, (req, res, next) => {
    const userId = req.session.user.id;
    const postId = req.params.id;

    const checkQuery = "SELECT * FROM likes WHERE user_id = ? AND post_id = ?";

    db.query(checkQuery, [userId, postId], (err, results) => {
        if (err) return next(err);

        const redirectUrl = req.headers.referer || `/posts/${postId}`;

        if (results.length > 0) {
            // ✅ UNLIKE (no notification)
            db.query(
                "DELETE FROM likes WHERE user_id = ? AND post_id = ?",
                [userId, postId],
                () => res.redirect(redirectUrl)
            );
        } else {
            // ✅ LIKE
            db.query(
                "INSERT INTO likes (user_id, post_id) VALUES (?, ?)",
                [userId, postId],
                (err) => {
                    if (err) return next(err);

                    // ✅ CREATE NOTIFICATION (only on LIKE)
                    const notifyQ = `
                        INSERT INTO notifications (user_id, sender_id, type, post_id)
                        SELECT p.user_id, ?, 'like', p.id
                        FROM posts p
                        WHERE p.id = ? AND p.user_id != ?
                    `;

                    db.query(notifyQ, [userId, postId, userId], () => {
                        res.redirect(redirectUrl);
                    });
                }
            );
        }
    });
});




// -----------------------------------------------------
// COMMENT ON POST
// -----------------------------------------------------
app.post("/posts/:id/comment", isLoggedIn, (req, res, next) => {
    const { comment } = req.body;
    const userId = req.session.user.id;
    const postId = req.params.id;

    if (!comment || comment.trim().length === 0) {
        return res.redirect(req.headers.referer || "/posts");
    }

    db.query(
        "INSERT INTO comments (post_id, user_id, comment) VALUES (?, ?, ?)",
        [postId, userId, comment.trim()],
        (err) => {
            if (err) return next(err);

            // ✅ CREATE NOTIFICATION (only if commenting on someone else's post)
            const notifyQ = `
                INSERT INTO notifications (user_id, sender_id, type, post_id)
                SELECT p.user_id, ?, 'comment', p.id
                FROM posts p
                WHERE p.id = ? AND p.user_id != ?
            `;

            db.query(notifyQ, [userId, postId, userId], () => {
                res.redirect(`/posts/${postId}`);
            });
        }
    );
});


// -----------------------------------------------------
// PROFILE ROUTES
// -----------------------------------------------------
// View profile
app.get("/profile/:id", isLoggedIn, (req, res, next) => {
    const profileId = parseInt(req.params.id, 10);
    const currentUserId = req.session.user.id;

    // 1. Get user
    const userQ = `
        SELECT id, username, email, avatar, bio
        FROM users
        WHERE id = ?
    `;

    db.query(userQ, [profileId], (err, userRows) => {
        if (err) return next(err);

        if (userRows.length === 0) {
            return res
                .status(404)
                .render("error.ejs", { message: "User not found" });
        }

        const user = userRows[0];

        // 2. Get posts + like count
        const postsQ = `
            SELECT p.*,
                (SELECT COUNT(*) FROM likes WHERE post_id = p.id) AS likeCount
            FROM posts p
            WHERE p.user_id = ?
            ORDER BY p.created_at DESC
        `;

        db.query(postsQ, [profileId], (err2, posts) => {
            if (err2) return next(err2);

            const safePosts = posts || [];
            const postIds = safePosts.map((p) => p.id);

            const attachMediaAndContinue = () => {
                // 4. Followers count
                const followersCountQ =
                    "SELECT COUNT(*) AS count FROM followers WHERE following_id = ?";
                const followingCountQ =
                    "SELECT COUNT(*) AS count FROM followers WHERE follower_id = ?";

                db.query(followersCountQ, [profileId], (err3, fRows) => {
                    if (err3) return next(err3);
                    const followers = fRows[0].count;

                    db.query(followingCountQ, [profileId], (err4, gRows) => {
                        if (err4) return next(err4);
                        const following = gRows[0].count;

                        // 5. Followers list
                        const followersListQ = `
                            SELECT u.id, u.username, u.avatar,
                                EXISTS(
                                    SELECT 1 FROM followers f2
                                    WHERE f2.follower_id = ? AND f2.following_id = u.id
                                ) AS youFollow
                            FROM followers f
                            JOIN users u ON f.follower_id = u.id
                            WHERE f.following_id = ?
                            ORDER BY u.username ASC
                        `;

                        db.query(
                            followersListQ,
                            [currentUserId, profileId],
                            (err5, followersList) => {
                                if (err5) followersList = [];

                                // 6. Following list
                                const followingListQ = `
                                    SELECT u.id, u.username, u.avatar,
                                        EXISTS(
                                            SELECT 1 FROM followers f2
                                            WHERE f2.follower_id = ? AND f2.following_id = u.id
                                        ) AS youFollow
                                    FROM followers f
                                    JOIN users u ON f.following_id = u.id
                                    WHERE f.follower_id = ?
                                    ORDER BY u.username ASC
                                `;

                                db.query(
                                    followingListQ,
                                    [currentUserId, profileId],
                                    (err6, followingListRows) => {
                                        if (err6) followingListRows = [];

                                        const mutualFollowers = [];
                                        const suggestedUsers = [];

                                        // Own profile
                                        if (currentUserId === profileId) {
                                            return res.render("profile.ejs", {
                                                user,
                                                posts: safePosts,
                                                followers,
                                                following,
                                                isFollowing: false,
                                                mutualFollowers,
                                                suggestedUsers,
                                                followersList,
                                                followingList: followingListRows,
                                            });
                                        }

                                        // 7. Is following?
                                        const isFollowingQ =
                                            "SELECT 1 FROM followers WHERE follower_id = ? AND following_id = ? LIMIT 1";

                                        db.query(
                                            isFollowingQ,
                                            [currentUserId, profileId],
                                            (err7, followRows) => {
                                                if (err7) return next(err7);

                                                const isFollowing =
                                                    followRows.length > 0;

                                                res.render("profile.ejs", {
                                                    user,
                                                    posts: safePosts,
                                                    followers,
                                                    following,
                                                    isFollowing,
                                                    mutualFollowers,
                                                    suggestedUsers,
                                                    followersList,
                                                    followingList: followingListRows,
                                                });
                                            }
                                        );
                                    }
                                );
                            }
                        );
                    });
                });
            };

            if (postIds.length === 0) {
                safePosts.forEach((p) => (p.media = []));
                return attachMediaAndContinue();
            }

            // 3. Get media for posts
            const mediaQ = `
                SELECT post_id, filename, media_type
                FROM post_media
                WHERE post_id IN (?)
            `;

            db.query(mediaQ, [postIds], (errM, mediaRows) => {
                if (errM) mediaRows = [];

                const mediaMap = {};
                mediaRows.forEach((m) => {
                    if (!mediaMap[m.post_id]) {
                        mediaMap[m.post_id] = [];
                    }
                    mediaMap[m.post_id].push(m);
                });

                safePosts.forEach((p) => {
                    p.media = mediaMap[p.id] || [];
                });

                attachMediaAndContinue();
            });
        });
    });
});

// Edit profile (form)
app.get("/profile/:id/edit", isLoggedIn, (req, res, next) => {
    const profileId = parseInt(req.params.id, 10);
    const currentUserId = req.session.user.id;

    if (profileId !== currentUserId) {
        return res
            .status(403)
            .render("error.ejs", { message: "You cannot edit this profile" });
    }

    db.query(
        "SELECT id, username, bio, avatar FROM users WHERE id = ?",
        [profileId],
        (err, rows) => {
            if (err) return next(err);
            if (rows.length === 0) {
                return res
                    .status(404)
                    .render("error.ejs", { message: "User not found" });
            }

            res.render("edit-profile.ejs", { user: rows[0] });
        }
    );
});

// Update profile
app.patch(
    "/profile/:id",
    isLoggedIn,
    avatarUpload.single("avatar"),
    (req, res, next) => {
        const profileId = parseInt(req.params.id, 10);
        const currentUserId = req.session.user.id;

        if (profileId !== currentUserId) {
            return res
                .status(403)
                .render("error.ejs", { message: "You cannot edit this profile" });
        }

        let { username, bio } = req.body;
        username = username ? username.trim() : "";
        bio = bio ? bio.trim() : null;

        if (!username || username.length < 3) {
            return res.render("edit-profile.ejs", {
                user: {
                    id: profileId,
                    username,
                    bio,
                    avatar: req.session.user.avatar,
                },
                error: "Username must be at least 3 characters long",
            });
        }

        if (bio && bio.length > 150) {
            bio = bio.substring(0, 150);
        }

        let query = "UPDATE users SET username = ?, bio = ?";
        const params = [username, bio];

        let newAvatarFile = null;
        if (req.file) {
            newAvatarFile = req.file.filename;
            query += ", avatar = ?";
            params.push(newAvatarFile);
        }

        query += " WHERE id = ?";
        params.push(profileId);

        db.query(query, params, (err, result) => {
            if (err) {
                let errorMessage = "Failed to update profile";
                if (
                    err.code === "ER_DUP_ENTRY" &&
                    err.sqlMessage.includes("username")
                ) {
                    errorMessage = "Username already exists";
                }

                return res.render("edit-profile.ejs", {
                    user: {
                        id: profileId,
                        username,
                        bio,
                        avatar: req.session.user.avatar,
                    },
                    error: errorMessage,
                });
            }

            // If new avatar uploaded, optionally delete old file
            if (newAvatarFile && req.session.user.avatar) {
                const oldPath = path.join(uploadPath, req.session.user.avatar);
                fs.unlink(oldPath, () => {});
            }

            // Update session user
            req.session.user.username = username;
            req.session.user.bio = bio;
            if (newAvatarFile) {
                req.session.user.avatar = newAvatarFile;
            }

            res.redirect(`/profile/${profileId}`);
        });
    }
);

// Followers page
app.get("/profile/:id/followers", isLoggedIn, (req, res, next) => {
    const profileId = parseInt(req.params.id, 10);

    const userQ = "SELECT id, username, avatar FROM users WHERE id = ?";

    const followersQ = `
        SELECT u.id, u.username, u.avatar
        FROM followers f
        JOIN users u ON f.follower_id = u.id
        WHERE f.following_id = ?
        ORDER BY u.username ASC
    `;

    db.query(userQ, [profileId], (err, userRows) => {
        if (err) return next(err);
        if (userRows.length === 0) {
            return res
                .status(404)
                .render("error.ejs", { message: "User not found" });
        }

        const profileUser = userRows[0];

        db.query(followersQ, [profileId], (err2, users) => {
            if (err2) return next(err2);

            res.render("followers.ejs", {
                profileUser,
                users,
                type: "followers",
            });
        });
    });
});

// Following page
app.get("/profile/:id/following", isLoggedIn, (req, res, next) => {
    const profileId = parseInt(req.params.id, 10);

    const userQ = "SELECT id, username, avatar FROM users WHERE id = ?";

    const followingQ = `
        SELECT u.id, u.username, u.avatar
        FROM followers f
        JOIN users u ON f.following_id = u.id
        WHERE f.follower_id = ?
        ORDER BY u.username ASC
    `;

    db.query(userQ, [profileId], (err, userRows) => {
        if (err) return next(err);
        if (userRows.length === 0) {
            return res
                .status(404)
                .render("error.ejs", { message: "User not found" });
        }

        const profileUser = userRows[0];

        db.query(followingQ, [profileId], (err2, users) => {
            if (err2) return next(err2);

            res.render("followers.ejs", {
                profileUser,
                users,
                type: "following",
            });
        });
    });
});



// -----------------------------------------------------
// FOLLOW
// -----------------------------------------------------
app.post("/follow/:id", isLoggedIn, (req, res, next) => {
    const currentUserId = req.session.user.id;
    const targetId = parseInt(req.params.id, 10);

    if (currentUserId === targetId) {
        return res.redirect(`/profile/${currentUserId}`);
    }

    const checkQ =
        "SELECT 1 FROM followers WHERE follower_id = ? AND following_id = ?";

    db.query(checkQ, [currentUserId, targetId], (err, rows) => {
        if (err) return next(err);

        // ✅ Already following — do nothing
        if (rows.length > 0) {
            return res.redirect(req.headers.referer || `/profile/${targetId}`);
        }

        // ✅ Follow
        db.query(
            "INSERT INTO followers (follower_id, following_id) VALUES (?, ?)",
            [currentUserId, targetId],
            (err2) => {
                if (err2) return next(err2);

                // ✅ CREATE FOLLOW NOTIFICATION
                db.query(
                    "INSERT INTO notifications (user_id, sender_id, type) VALUES (?, ?, 'follow')",
                    [targetId, currentUserId],
                    () => {
                        res.redirect(req.headers.referer || `/profile/${targetId}`);
                    }
                );
            }
        );
    });
});
 



app.post("/unfollow/:id", isLoggedIn, (req, res, next) => {
    const currentUserId = req.session.user.id;
    const targetId = parseInt(req.params.id, 10);

    db.query(
        "DELETE FROM followers WHERE follower_id = ? AND following_id = ?",
        [currentUserId, targetId],
        (err) => {
            if (err) return next(err);
            res.redirect(req.headers.referer || `/profile/${targetId}`);
        }  
    );
});

// Remove someone who follows you
app.post("/remove-follower/:id", isLoggedIn, (req, res, next) => {
    const currentUserId = req.session.user.id;
    const followerId = parseInt(req.params.id, 10);

    db.query(
        "DELETE FROM followers WHERE follower_id = ? AND following_id = ?",
        [followerId, currentUserId],
        (err) => {
            if (err) return next(err);
            res.redirect(req.headers.referer || `/profile/${currentUserId}`);
        }
    );
});


// -----------------------------------------------------
// NOTIFICATIONS
// -----------------------------------------------------

// Unread count for navbar badge
app.get("/api/notifications/unread-count", isLoggedIn, (req, res) => {
    const userId = req.session.user.id;

    const q = `
        SELECT COUNT(*) AS cnt
        FROM notifications
        WHERE user_id = ? AND is_read = 0
    `;

    db.query(q, [userId], (err, rows) => {
        if (err) {
            console.error("Unread notifications error:", err);
            return res.json({ ok: false, count: 0 });
        }
        res.json({ ok: true, count: rows[0].cnt });
    });
});
// Notifications page
app.get("/notifications", isLoggedIn, (req, res, next) => {
    const userId = req.session.user.id;

const q = `
    SELECT 
        n.*,
        u.username,
        u.avatar
    FROM notifications n
    JOIN users u ON n.sender_id = u.id
    WHERE n.user_id = ?
    ORDER BY n.created_at DESC
`;


    db.query(q, [userId], (err, notifications) => {
        if (err) return next(err);

        const markReadQ = `
            UPDATE notifications 
            SET is_read = 1 
            WHERE user_id = ? AND is_read = 0
        `;

        db.query(markReadQ, [userId], () => {
            res.render("notifications.ejs", { notifications });
        });
    });
});


// -----------------------------------------------------
// MESSAGES (REAL-TIME USING POLLING)
// -----------------------------------------------------

// Chat page between logged-in user and :userId
app.get("/messages/:userId", isLoggedIn, (req, res, next) => {
    const myId = req.session.user.id;
    const otherId = parseInt(req.params.userId, 10);

    if (myId === otherId) {
        return res.redirect(`/profile/${myId}`);
    }

    const userQ = "SELECT id, username, avatar FROM users WHERE id = ?";

    db.query(userQ, [otherId], (err, rows) => {
        if (err) return next(err);
        if (rows.length === 0) {
            return res.status(404).render("error.ejs", { message: "User not found" });
        }

        const otherUser = rows[0];

        const messagesQ = `
            SELECT m.*, u.username AS sender_name, u.avatar AS sender_avatar
            FROM messages m
            JOIN users u ON m.sender_id = u.id
            WHERE (m.sender_id = ? AND m.receiver_id = ?)
               OR (m.sender_id = ? AND m.receiver_id = ?)
            ORDER BY m.created_at ASC
        `;

        db.query(messagesQ, [myId, otherId, otherId, myId], (err2, messages) => {
            if (err2) return next(err2);

            res.render("messages.ejs", {
                me: {
                    id: myId,
                    username: req.session.user.username,
                    avatar: req.session.user.avatar,
                },
                otherUser,
                messages,
                currentUserId: myId,
            });
        });
    });
});

// SEND MESSAGE (AJAX)
app.post("/api/messages/:userId", isLoggedIn, (req, res, next) => {
    const myId = req.session.user.id;
    const otherId = parseInt(req.params.userId, 10);

    const content = (req.body.content || "").trim();

    if (!content) {
        return res.status(400).json({ ok: false, error: "Message is empty" });
    }

    const insertQ = `
        INSERT INTO messages (sender_id, receiver_id, content)
        VALUES (?, ?, ?)
    `;

    db.query(insertQ, [myId, otherId, content], (err, result) => {
        if (err) return next(err);

        // 🔔 ALSO CREATE A NOTIFICATION HERE (✅ FIXED)
        const notifQ = `
            INSERT INTO notifications (user_id, sender_id, type, is_read)
            VALUES (?, ?, 'message', 0)
        `;

        db.query(notifQ, [otherId, myId], (notifErr) => {
            if (notifErr) {
                console.error("Notification insert error:", notifErr);
                // don't break the chat if this fails
            }

            res.json({
                ok: true,
                message: {
                    id: result.insertId,
                    sender_id: myId,
                    receiver_id: otherId,
                    content,
                    created_at: new Date(),
                },
            });
        });
    });
});



// FETCH NEW MESSAGES (POLLING)
app.get("/api/messages/:userId", isLoggedIn, (req, res, next) => {
    const myId = req.session.user.id;
    const otherId = parseInt(req.params.userId, 10);
    const afterId = parseInt(req.query.after || "0", 10);

    const messagesQ = `
        SELECT m.*, u.username AS sender_name, u.avatar AS sender_avatar
        FROM messages m
        JOIN users u ON m.sender_id = u.id
        WHERE ((m.sender_id = ? AND m.receiver_id = ?)
            OR (m.sender_id = ? AND m.receiver_id = ?))
          AND m.id > ?
        ORDER BY m.created_at ASC
    `;

    db.query(messagesQ, [myId, otherId, otherId, myId, afterId], (err, rows) => {
        if (err) return next(err);
        res.json({ ok: true, messages: rows });
    });
});
// -----------------------------------------------------
// CAPTION SUGGESTION API
// -----------------------------------------------------
app.post("/api/suggest-caption", isLoggedIn, (req, res) => {
    try {
        const { keywords = [], currentCaption = "" } = req.body || {};

        const captions = [
            "Just capturing the moment ✨",
            "One frame, many feelings ❤️",
            "A small glimpse from today 📸",
            "Memories in the making 🌸",
            "Another day, another story 🌍",
            "Mood speaks louder than words 💭",
            "Keeping it real ✨",
            "Moments that matter 💙",
        ];

        const emojis = ["✨", "📸", "🔥", "❤️", "🌸", "💫", "😌", "🌿"];

        const random = arr => arr[Math.floor(Math.random() * arr.length)];

        let caption = random(captions);

        if (keywords.includes("video")) caption += " 🎬";
        if (keywords.includes("photo")) caption += " 📷";

        caption += " " + random(emojis);

        if (currentCaption.trim()) {
            caption = currentCaption.trim() + "\n\n" + caption;
        }

        res.json({ ok: true, caption });

    } catch (err) {
        console.error("Caption generator error:", err);
        res.status(500).json({ ok: false });
    }
});

// -----------------------------------------------------
// REGISTER
// -----------------------------------------------------
app.get("/register", (req, res) => {
    if (req.session.user) return res.redirect("/posts");
    res.render("register.ejs");
});

app.post("/register", (req, res, next) => {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
        return res.render("register.ejs", {
            error: "All fields are required",
            username,
            email,
        });
    }

    const hashed = bcrypt.hashSync(password, 10);

    db.query(
        "INSERT INTO users (username, email, password) VALUES (?, ?, ?)",
        [username.trim(), email.trim(), hashed],
        (err) => {
            if (err) {
                let errorMessage = "Registration failed";

                if (err.code === "ER_DUP_ENTRY") {
                    if (err.sqlMessage.includes("username")) {
                        errorMessage = "Username already exists";
                    } else if (err.sqlMessage.includes("email")) {
                        errorMessage = "Email already exists";
                    }
                }

                return res.render("register.ejs", {
                    error: errorMessage,
                    username,
                    email,
                });
            }

            res.redirect("/login");
        }
    );
});

// -----------------------------------------------------
// LOGIN
// -----------------------------------------------------
app.get("/login", (req, res) => {
    if (req.session.user) return res.redirect("/posts");
    res.render("login.ejs");
});

app.post("/login", (req, res, next) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.render("login.ejs", {
            error: "Email and password are required",
        });
    }

    db.query("SELECT * FROM users WHERE email = ?", [email], (err, rows) => {
        if (err) return next(err);

        if (rows.length === 0) {
            return res.render("login.ejs", { error: "User not found", email });
        }

        const user = rows[0];
        if (!bcrypt.compareSync(password, user.password)) {
            return res.render("login.ejs", { error: "Wrong password", email });
        }

        req.session.user = user;
        res.redirect("/posts");
    });
});

// -----------------------------------------------------
// LOGOUT
// -----------------------------------------------------
app.get("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/login"));
});

// -----------------------------------------------------
// ROOT ROUTE
// -----------------------------------------------------
app.get("/", (req, res) => {
    if (req.session.user) return res.redirect("/posts");
    res.redirect("/login");
});

// -----------------------------------------------------
// ERROR HANDLING
// -----------------------------------------------------
app.use((err, req, res, next) => {
    console.error("Unhandled error:", err);

    if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).render("error.ejs", {
            message:
                "File too large. Max 20MB for posts/stories and 5MB for profile pictures.",
        });
    }

    if (err instanceof multer.MulterError) {
        return res.status(400).render("error.ejs", {
            message: "Upload error: " + err.message,
        });
    }

    res.status(500).render("error.ejs", {
        message: "Something went wrong!",
    });
});
// -----------------------------------------------------
// PRIVACY PAGE
// -----------------------------------------------------
app.get("/privacy", (req, res) => {
    res.render("privacy");
});

// 404
app.use((req, res) => {
    res.status(404).render("error.ejs", { message: "Page not found" });
});

// -----------------------------------------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});

 



