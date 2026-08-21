I want a a full-stack cloud drive (like Yandex Disk, CLoudflare, Supabase, pcloud, google drive, onedrive, mega, apple cloud, Dropbox, Proton Drive, Google Cloud Storage, Microsoft Azure Blob Storage, Amazon S3, DigitalOcean Spaces, Backblaze B2, Wasabi, Bunny Storage) aggregation platform that presents multiple storage providers through a single, consistent workspace. I enabling users to browse, upload, download, and manage files across connected cloud accounts from one interface.

✨ Key features
☁️ Multi-provider cloud aggregation
Connect multiple cloud storage accounts in one application
All providers are normalized through a consistent adapter layer
Active provider support includes OAuth, account-based login, and access-key-based connections
🗂️ Unified file workspace
Home, My Drive, Recent, Starred, Shared with Me, and Quota views
Virtual-path-based file navigation across providers
File metadata is presented consistently across different provider sources
📁 File management
Browse files and folders from connected accounts
Create folders
Rename files and folders
Delete files and folders, including bulk delete
Download provider files
View file details and previews for supported file types
Star / unstar files on providers that support it
⬆️ Upload system
Browser-based file uploads
Folder upload support
Drag-and-drop uploads
Upload session initiation through the API
Real-time upload progress over WebSocket
Automatic upload account allocation based on storage selection strategy
🔄 Sync and metadata mirror
File metadata is stored in SQLite for fast navigation
Account synchronization runs on a schedule using node-cron
The API exposes a manual sync trigger
Delta sync reports are available through the health/sync layer
👤 Auth and app modes
local mode for personal or simple self-hosted usage
hosted mode for multi-user deployments with session-cookie-based register/login/logout
Account data, file mirrors, allocation config, and settings are scoped per user
⚙️ User settings and storage allocation
workspace and drive sharing
Roles
fully RBAC
User settings such as language and theme
Storage allocation strategies:
round_robin
weighted_round_robin
least_used
most_free
manual
Account priority order can be configured for the manual strategy


At a high level:

The frontend calls the REST API for auth, accounts, files, uploads, settings, and allocation
The backend selects the appropriate provider adapter (google_drive, onedrive, dropbox, mega, pcloud, yandex, s3)
Provider responses are normalized into the Orbit data model
File metadata is mirrored into SQLite for fast access
Upload progress is pushed to the client over WebSocket
The sync service keeps local metadata aligned with provider state


The frontend currently includes these main views:

/ → Home dashboard
/my-drive → main file explorer
/shared-with-me → shared files from supported providers
/recent → recent files
/starred → starred files
/quota → quota overview, account management, allocation settings
/login and /register → used in hosted mode


i can also access it across multiple devices and screen size and with PWA
When an upload starts, the backend selects the target account based on the user's allocation configuration. This allows file distribution across providers to be automatic or manually prioritized depending on the user's preference.

Example use cases:

Distribute uploads across multiple accounts in rotation
Prioritize the account with the most free space
Enforce a specific manual ordering

Important data stored locally includes:

Mirrored file metadata in SQLite (backend/orbit.db)
Linked account metadata
Encrypted provider credentials / token material
User settings
Allocation config and rotation state
Auth session data for hosted mode
i can connects multiple accounts from same provider
i name this project Orbit and host on orbit.harshitsaini.in and i want to make this project with 0% cost with claude code
when i share file or public file the link don't share drive link, it share link like https://orbit.harshitsaini.in/bibi42bi342i3v434i3434vi like this and preview it also in my place adn i want link as well as QR sharing also 
I want to use multi step authentication using email otp and fully secure and use resend api
i use GitHub or source control and make project public i use GitHub CLI and git and i want than public don't guess that it is made with help of any AI and claude code make proper doc inside doc folder like projects state daily working phases project states 
for testing use multiple MCP like framer MCP, playwright MCP and many more, use playwtight such i watch what it is testing i will show in GUI
also claude add co authorized tag in git commit i don't want it
make UI/UX excellent, with theme option from main page to login and control panel, make a superadmin panel also, use proper glow, hover effects, etc. make design 'Claymorphism' and use three.js also


claude will make this project in English but explain me every step and what to do in Hinglish
Now with you 100x deep thinking make a full architecture, roadmap and claude instruction, timeline, implementation plan, design, etc.