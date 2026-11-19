
const API_URL = (() => {
    const hostname = location.hostname || "127.0.0.1";
    const apiPort = location.port === "30082" ? "30081" : "8001";
    const protocol = location.protocol === "https:" ? "https:" : "http:";
    return `${protocol}//${hostname}:${apiPort}`;
})();

let campaignsData = [];
let semanticSearchResults = null;
let searchRequestNumber = 0;
let searchDebounceTimer = null;
let generatedCampaignData = null;
let editingCampaignId = null;
let currentUser = null;
const currentPage = document.body.dataset.page || "dashboard";

// ==========================================
// AUTHENTICATED API REQUEST
// ==========================================

async function authenticatedFetch(url, options = {}) {
    const token = localStorage.getItem("access_token");

    if (!token) {
        localStorage.removeItem("access_token");
        location.reload();
        throw new Error("Please log in again.");
    }

    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${token}`);

    const response = await fetch(url, {
        ...options,
        headers
    });

    if (response.status === 401) {
        localStorage.removeItem("access_token");
        alert("Your session has expired. Please log in again.");
        location.reload();
        throw new Error("Session expired. Please log in again.");
    }

    return response;
}

// ==========================================
// USER AUTHENTICATION
// ==========================================

let authMode = "login";

function showAuthScreen() {
    const authScreen = document.getElementById("authScreen");
    const appContainer = document.getElementById("appContainer");

    if (!authScreen) {
        location.replace("index.html");
        return;
    }

    authScreen.style.display = "grid";
    appContainer.style.display = "none";
}

function showDashboard(user) {
    currentUser = user;

    const authScreen = document.getElementById("authScreen");
    if (authScreen) authScreen.style.display = "none";
    document.getElementById("appContainer").style.display = "";
    renderHeader(user);

    const adminUsersNav = document.getElementById("adminUsersNav");
    const isAdmin = user.role === "admin";

    if (adminUsersNav) {
        adminUsersNav.classList.toggle("hidden", !isAdmin);
    }

    if (currentPage === "users" && !isAdmin) {
        location.replace("index.html");
        return;
    }

    if (currentPage === "users") {
        loadUsers();
    }

    const workspaceUsername = document.getElementById("workspaceUsername");
    const workspaceRole = document.getElementById("workspaceRole");
    if (workspaceUsername) workspaceUsername.textContent = user.username;
    if (workspaceRole) {
        workspaceRole.textContent =
            user.role === "admin" ? "Workspace administrator" : "Workspace member";
    }

    if (["dashboard", "campaigns", "analytics"].includes(currentPage)) {
        loadCampaigns();
    }

    if (currentPage === "assistant") {
        loadPdfDocuments();
    }
}

function bindIfExists(id, eventName, handler) {
    const element = document.getElementById(id);
    if (element) element.addEventListener(eventName, handler);
}

function renderHeader(user) {
    const header = document.getElementById("siteHeader");
    if (!header) return;

    const initial = escapeHTML(user.username.charAt(0).toUpperCase());
    const username = escapeHTML(user.username);
    const isAdmin = user.role === "admin";

    header.innerHTML = `
        <div class="header-inner">
            <a class="brand" href="index.html" aria-label="CampaignAI dashboard">
                <span class="brand-name">Campaign<span>AI</span></span>
            </a>
            <button class="mobile-nav-toggle" id="mobileNavToggle"
                type="button" aria-expanded="false" aria-controls="primaryNav"
                aria-label="Open navigation">
                <span></span><span></span>
            </button>
            <nav class="primary-nav" id="primaryNav" aria-label="Main navigation">
                <a class="nav-link" data-page-link="dashboard" href="index.html">Overview</a>
                <a class="nav-link" data-page-link="campaigns" href="campaigns.html">Campaigns</a>
                <a class="nav-link" data-page-link="generator" href="generator.html">AI Studio</a>
                <a class="nav-link" data-page-link="assistant" href="assistant.html">Assistant</a>
                <a class="nav-link" data-page-link="analytics" href="analytics.html">Analytics</a>
                <a class="nav-link hidden" id="adminUsersNav"
                    data-page-link="users" href="users.html">Team</a>
                <a class="nav-link" data-page-link="settings" href="settings.html">Workspace</a>
            </nav>
            <div class="header-account">
                <span class="header-avatar" aria-hidden="true">${initial}</span>
                <span class="header-user">
                    <strong>${username}</strong>
                    <small>${isAdmin ? "Administrator" : "Workspace member"}</small>
                </span>
                <button class="logout-button" id="logoutBtn" type="button">Sign out</button>
            </div>
        </div>
    `;

    const activeLink = header.querySelector(`[data-page-link="${currentPage}"]`);
    if (activeLink) activeLink.classList.add("active");

    const usersLink = document.getElementById("adminUsersNav");
    if (usersLink) usersLink.classList.toggle("hidden", !isAdmin);

    const toggle = document.getElementById("mobileNavToggle");
    const nav = document.getElementById("primaryNav");
    toggle.addEventListener("click", () => {
        const isOpen = toggle.getAttribute("aria-expanded") === "true";
        toggle.setAttribute("aria-expanded", String(!isOpen));
        toggle.setAttribute("aria-label", isOpen ? "Open navigation" : "Close navigation");
        nav.classList.toggle("is-open", !isOpen);
    });

    bindIfExists("logoutBtn", "click", () => {
        localStorage.removeItem("access_token");
        location.assign("index.html");
    });
}

function switchAuthMode() {
    authMode = authMode === "login" ? "register" : "login";

    document.getElementById("authTitle").textContent =
        authMode === "login" ? "Login to CampaignAI" : "Create Account";

    document.getElementById("usernameGroup").classList.toggle(
        "hidden",
        authMode !== "register"
    );

    document.getElementById("authUsername").required =
        authMode === "register";

    document.getElementById("authSubmitBtn").textContent =
        authMode === "login" ? "Login" : "Register";

    document.getElementById("authSwitchText").textContent =
        authMode === "login"
            ? "Don't have an account?"
            : "Already have an account?";

    document.getElementById("authSwitchBtn").textContent =
        authMode === "login" ? "Register" : "Login";

    document.getElementById("authStatus").textContent = "";
}

bindIfExists("authSwitchBtn",
    "click",
    switchAuthMode
);

bindIfExists("authForm",
    "submit",
    async function(event) {
        event.preventDefault();

        const username = document.getElementById("authUsername").value.trim();
        const email = document.getElementById("authEmail").value.trim();
        const password = document.getElementById("authPassword").value;

        const status = document.getElementById("authStatus");
        const button = document.getElementById("authSubmitBtn");

        button.disabled = true;
        status.textContent = "Please wait...";

        try {
            if (authMode === "register") {
                const registerResponse = await fetch(`${API_URL}/register`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        username,
                        email,
                        password
                    })
                });

                const registerData = await registerResponse.json();

                if (!registerResponse.ok) {
                    throw new Error(
                        registerData.detail || "Registration failed."
                    );
                }

                status.textContent =
                    "Registration successful! Logging in...";
            }

            const loginResponse = await fetch(`${API_URL}/login`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    email,
                    password
                })
            });

            const loginData = await loginResponse.json();

            if (!loginResponse.ok) {
                throw new Error(loginData.detail || "Login failed.");
            }

            localStorage.setItem("access_token", loginData.access_token);
            showDashboard(loginData.user);

        } catch (error) {
            status.textContent = error.message;

        } finally {
            button.disabled = false;
        }
    }
);

// Restore existing login session
async function checkLogin() {
    const token = localStorage.getItem("access_token");

    if (!token) {
        if (currentPage === "dashboard") {
            showAuthScreen();
        } else {
            location.replace("index.html");
        }
        return;
    }

    try {
        const response = await fetch(`${API_URL}/users/me`, {
            headers: {
                "Authorization": `Bearer ${token}`
            }
        });

        if (!response.ok) {
            throw new Error("Session expired.");
        }

        const user = await response.json();
        showDashboard(user);

    } catch (error) {
        localStorage.removeItem("access_token");
        if (currentPage === "dashboard") {
            showAuthScreen();
        } else {
            location.replace("index.html");
        }
    }
}

// ==========================================
// COMMON HELPER FUNCTIONS
// ==========================================

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[character]);
}

function formatBudget(value) {
    return "₹" + Number(value || 0).toLocaleString("en-IN");
}

// ==========================================
// ADMIN USER MANAGEMENT
// ==========================================

async function loadUsers() {
    const tableBody = document.getElementById("usersTableBody");
    const status = document.getElementById("userManagementStatus");

    if (!currentUser || currentUser.role !== "admin") {
        return;
    }

    tableBody.innerHTML = `
        <tr><td colspan="6">Loading users...</td></tr>
    `;

    status.textContent = "";

    try {
        const response = await authenticatedFetch(`${API_URL}/admin/users`);
        const users = await response.json();

        if (!response.ok) {
            throw new Error(users.detail || "Unable to load users.");
        }

        if (users.length === 0) {
            tableBody.innerHTML = `
                <tr><td colspan="6">No registered users found.</td></tr>
            `;
            return;
        }

        tableBody.innerHTML = users.map(user => {
            const isCurrentUser = user.id === currentUser.id;
            const isDeleting = user.role === "deleting";

            return `
                <tr>
                    <td>${user.id}</td>
                    <td>${escapeHTML(user.username)}</td>
                    <td>${escapeHTML(user.email)}</td>
                    <td>
                        <span class="campaign-status">
                            ${escapeHTML(user.role)}
                        </span>
                    </td>
                    <td>
                        <select
                            class="user-role-select"
                            data-user-id="${user.id}"
                            ${isCurrentUser || isDeleting ? "disabled" : ""}
                        >
                            ${
                                isDeleting
                                    ? '<option value="deleting" selected>Deleting</option>'
                                    : ""
                            }
                            <option value="user"
                                ${user.role === "user" ? "selected" : ""}>
                                User
                            </option>
                            <option value="admin"
                                ${user.role === "admin" ? "selected" : ""}>
                                Admin
                            </option>
                        </select>
                    </td>
                    <td>
                        ${
                            isCurrentUser
                                ? "<span>Current account</span>"
                                : isDeleting
                                ? `
                                    <span>Deletion pending</span>
                                    <button
                                        type="button"
                                        class="delete-user-btn"
                                        data-user-id="${user.id}"
                                        data-username="${escapeHTML(user.username)}"
                                        data-pending="true">
                                        Retry cleanup
                                    </button>
                                `
                                : `
                                    <button
                                        type="button"
                                        class="save-user-role-btn"
                                        data-user-id="${user.id}">
                                        Save Role
                                    </button>
                                    <button
                                        type="button"
                                        class="delete-user-btn"
                                        data-user-id="${user.id}"
                                        data-username="${escapeHTML(user.username)}"
                                        data-pending="false">
                                        Delete
                                    </button>
                                `
                        }
                    </td>
                </tr>
            `;
        }).join("");

        status.textContent =
            `Successfully loaded ${users.length} user(s).`;

    } catch (error) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="6">
                    Unable to load users: ${escapeHTML(error.message)}
                </td>
            </tr>
        `;

        status.textContent = error.message;
        console.error("User loading error:", error);
    }
}

bindIfExists("refreshUsersBtn",
    "click",
    loadUsers
);

async function updateUserRole(userId, button) {
    const roleSelect = document.querySelector(
        `.user-role-select[data-user-id="${userId}"]`
    );

    const status = document.getElementById("userManagementStatus");

    if (!roleSelect) return;

    const selectedRole = roleSelect.value;

    if (!["user", "admin"].includes(selectedRole)) {
        status.textContent = "Invalid role selected.";
        return;
    }

    if (!confirm(
        `Are you sure you want to change this user's role to ${selectedRole}?`
    )) {
        return;
    }

    button.disabled = true;
    button.textContent = "Saving...";

    try {
        const response = await authenticatedFetch(
            `${API_URL}/admin/users/${userId}/role`,
            {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ role: selectedRole })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.detail || "Role update failed.");
        }

        status.textContent =
            `${data.username}'s role updated to ${data.role} successfully.`;

        await loadUsers();

    } catch (error) {
        status.textContent = error.message;
        console.error("Role update error:", error);

        button.disabled = false;
        button.textContent = "Save Role";
    }
}

async function deleteUser(userId, button) {
    const status = document.getElementById("userManagementStatus");
    const username = button.dataset.username;
    const isRetry = button.dataset.pending === "true";

    if (!confirm(
        isRetry
            ? `Retry data cleanup for ${username}?`
            : `Delete ${username} and permanently remove their campaigns, PDFs, and chat history?`
    )) {
        return;
    }

    button.disabled = true;
    button.textContent = isRetry ? "Retrying..." : "Deleting...";

    try {
        const response = await authenticatedFetch(
            `${API_URL}/admin/users/${userId}`,
            { method: "DELETE" }
        );
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.detail || "User deletion failed.");
        }

        await loadUsers();
        status.textContent =
            `${username} and their associated data were deleted.`;
    } catch (error) {
        status.textContent = error.message;
        console.error("User deletion error:", error);
        button.disabled = false;
        button.textContent = isRetry ? "Retry cleanup" : "Delete";
    }
}

bindIfExists("usersTableBody",
    "click",
    async function(event) {
        const button = event.target.closest(
            ".save-user-role-btn, .delete-user-btn"
        );

        if (!button) return;

        if (button.classList.contains("delete-user-btn")) {
            await deleteUser(button.dataset.userId, button);
            return;
        }

        await updateUserRole(button.dataset.userId, button);
    }
);

// ==========================================
// CAMPAIGN MANAGEMENT
// ==========================================

async function loadCampaigns() {
    const campaignList = document.getElementById("campaignList");

    try {
        const response = await authenticatedFetch(`${API_URL}/campaigns`);

        if (!response.ok) {
            throw new Error("Could not load campaigns.");
        }

        campaignsData = await response.json();

        // Reset semantic results when campaign data is refreshed.
        semanticSearchResults = null;

        updateDashboard();
        if (campaignList) displayCampaigns();

    } catch (error) {
        if (campaignList) {
            campaignList.innerHTML =
                '<p class="empty-message">Unable to load campaigns. Check FastAPI.</p>';
        }

        console.error("Campaign loading error:", error);
    }
}

function updateDashboard() {
    const total = campaignsData.length;

    const active = campaignsData.filter(
        campaign => campaign.status?.toLowerCase() === "active"
    ).length;

    const totalBudget = campaignsData.reduce(
        (sum, campaign) => sum + Number(campaign.budget || 0),
        0
    );

    const totalElement = document.getElementById("totalCampaigns");
    const activeElement = document.getElementById("activeCampaigns");
    const budgetElement = document.getElementById("totalBudget");

    if (totalElement) totalElement.textContent = total;
    if (activeElement) activeElement.textContent = active;
    if (budgetElement) budgetElement.textContent = formatBudget(totalBudget);

    if (document.getElementById("analyticsTotal")) updateAnalytics();
}

// Display campaigns, including semantic search results.
function displayCampaigns() {
    const campaignList = document.getElementById("campaignList");

    const searchInput = document.getElementById("campaignSearch");
    const statusFilter = document.getElementById("campaignStatusFilter");

    const searchText = searchInput?.value.toLowerCase().trim() || "";
    const selectedStatus = statusFilter?.value || "all";

    const sourceCampaigns =
        semanticSearchResults !== null
            ? semanticSearchResults
            : campaignsData;

    let filteredCampaigns = sourceCampaigns.filter(campaign => {
        // Normal search matches campaign name and details.
        // Semantic search results are already ranked by the backend.
        const matchesSearch =
            semanticSearchResults !== null ||
            !searchText ||
            [
                campaign.name,
                campaign.description,
                campaign.target_audience
            ].some(value =>
                String(value || "").toLowerCase().includes(searchText)
            );

        const matchesStatus =
            selectedStatus === "all" ||
            String(campaign.status || "").toLowerCase() ===
                selectedStatus.toLowerCase();

        return matchesSearch && matchesStatus;
    });

    if (currentPage === "dashboard") {
        filteredCampaigns = filteredCampaigns.slice(0, 4);
    }

    if (filteredCampaigns.length === 0) {
        campaignList.innerHTML = `
            <p class="empty-message">No matching campaigns found.</p>
        `;
        return;
    }

    const actions = currentPage === "campaigns";

    campaignList.innerHTML = filteredCampaigns.map(campaign => `
        <div class="campaign-item">
            <div>
                <h3>${escapeHTML(campaign.name)}</h3>
                <p>${escapeHTML(
                    campaign.target_audience || "No target audience"
                )}</p>
                <p>Budget: ${formatBudget(campaign.budget)}</p>
            </div>

            ${actions ? `<div class="campaign-actions">
                <span class="campaign-status">
                    ${escapeHTML(campaign.status)}
                </span>

                <button type="button"
                    class="edit-campaign-btn"
                    data-id="${campaign.id}">
                    Edit
                </button>

                <button type="button"
                    class="delete-campaign-btn"
                    data-id="${campaign.id}">
                    Delete
                </button>
            </div>` : `<span class="campaign-status">${escapeHTML(campaign.status)}</span>`}
        </div>
    `).join("");
}

// ==========================================
// AI-POWERED SEMANTIC CAMPAIGN SEARCH
// ==========================================

async function performCampaignSearch() {
    const searchInput = document.getElementById("campaignSearch");
    const campaignList = document.getElementById("campaignList");

    const query = searchInput.value.trim();
    const requestNumber = ++searchRequestNumber;

    // Empty search: show all normal campaigns.
    if (!query) {
        semanticSearchResults = null;
        displayCampaigns();
        return;
    }

    campaignList.innerHTML = `
        <p class="empty-message">AI is searching for relevant campaigns...</p>
    `;

    try {
        const response = await authenticatedFetch(
            `${API_URL}/campaigns/search`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    query: query,
                    limit: 10
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            throw new Error(
                data.detail || "AI campaign search failed."
            );
        }

        // Ignore an older search response if a newer search was started.
        if (requestNumber !== searchRequestNumber) {
            return;
        }

        // Support either a direct list or a response object.
        if (Array.isArray(data)) {
            semanticSearchResults = data;
        } else if (Array.isArray(data.results)) {
            semanticSearchResults = data.results;
        } else if (Array.isArray(data.campaigns)) {
            semanticSearchResults = data.campaigns;
        } else {
            semanticSearchResults = [];
        }

        displayCampaigns();

    } catch (error) {
        if (requestNumber !== searchRequestNumber) {
            return;
        }

        console.error("Semantic search error:", error);

        // Fallback to ordinary local name/details search.
        semanticSearchResults = null;
        displayCampaigns();
    }
}

bindIfExists("campaignSearch",
    "input",
    () => {
        clearTimeout(searchDebounceTimer);

        searchDebounceTimer = setTimeout(() => {
            performCampaignSearch();
        }, 500);
    }
);

bindIfExists("campaignStatusFilter",
    "change",
    displayCampaigns
);

// Handle Edit and Delete campaign buttons.
bindIfExists("campaignList",
    "click",
    async function(event) {
        const button = event.target.closest("button");

        if (!button) return;

        const campaignId = button.dataset.id;

        if (!campaignId) return;

        if (button.classList.contains("edit-campaign-btn")) {
            const campaign = campaignsData.find(
                item => String(item.id) === String(campaignId)
            );

            if (!campaign) return;

            editingCampaignId = campaign.id;

            document.getElementById("editCampaignName").value =
                campaign.name || "";

            document.getElementById("editCampaignDescription").value =
                campaign.description || "";

            document.getElementById("editTargetAudience").value =
                campaign.target_audience || "";

            document.getElementById("editCampaignBudget").value =
                Number(campaign.budget || 0);

            document.getElementById("editCampaignStatus").textContent = "";

            document.getElementById("editCampaignForm")
                .classList.remove("hidden");

            document.getElementById("editCampaignForm").scrollIntoView({
                behavior: "smooth",
                block: "nearest"
            });

            document.getElementById("editCampaignName").focus();

            return;
        }

        if (button.classList.contains("delete-campaign-btn")) {
            if (!confirm(
                "Are you sure you want to delete this campaign?"
            )) {
                return;
            }

            try {
                const response = await authenticatedFetch(
                    `${API_URL}/campaigns/${campaignId}`,
                    { method: "DELETE" }
                );

                if (!response.ok) {
                    throw new Error("Campaign deletion failed.");
                }

                alert("Campaign deleted successfully!");
                await loadCampaigns();

            } catch (error) {
                alert(error.message);
            }
        }
    }
);

// Save edited campaign.
bindIfExists("editCampaignForm",
    "submit",
    async event => {
        event.preventDefault();

        if (editingCampaignId === null) return;

        const form = event.currentTarget;

        if (!form.reportValidity()) return;

        const name =
            document.getElementById("editCampaignName").value.trim();

        const description =
            document.getElementById("editCampaignDescription").value;

        const audience =
            document.getElementById("editTargetAudience").value;

        const budget =
            Number(document.getElementById("editCampaignBudget").value);

        const saveButton =
            document.getElementById("saveEditedCampaignBtn");

        const status =
            document.getElementById("editCampaignStatus");

        if (!name || !Number.isFinite(budget) || budget < 0) {
            status.textContent =
                "Enter a campaign name and a valid non-negative budget.";
            return;
        }

        saveButton.disabled = true;
        saveButton.textContent = "Saving...";
        status.textContent = "Saving your changes...";

        try {
            const response = await authenticatedFetch(
                `${API_URL}/campaigns/${editingCampaignId}`,
                {
                    method: "PUT",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        name,
                        description,
                        target_audience: audience,
                        budget
                    })
                }
            );

            if (!response.ok) {
                throw new Error("Campaign update failed.");
            }

            status.textContent = "Campaign updated successfully.";

            editingCampaignId = null;
            form.classList.add("hidden");

            await loadCampaigns();

        } catch (error) {
            status.textContent = error.message;
            console.error("Campaign update error:", error);

        } finally {
            saveButton.disabled = false;
            saveButton.textContent = "Save Changes";
        }
    }
);

const cancelEditCampaign = () => {
        editingCampaignId = null;

        document.getElementById("editCampaignForm")
            .classList.add("hidden");

        document.getElementById("editCampaignStatus").textContent = "";
    };

bindIfExists("cancelEditCampaignBtn", "click", cancelEditCampaign);
bindIfExists("cancelEditCampaignAction", "click", cancelEditCampaign);

// ==========================================
// ANALYTICS
// ==========================================

function updateAnalytics() {
    if (!document.getElementById("analyticsTotal")) return;

    const total = campaignsData.length;

    const active = campaignsData.filter(
        campaign => campaign.status?.toLowerCase() === "active"
    ).length;

    const draft = campaignsData.filter(
        campaign => campaign.status?.toLowerCase() === "draft"
    ).length;

    const totalBudget = campaignsData.reduce(
        (sum, campaign) => sum + Number(campaign.budget || 0),
        0
    );

    const average = total > 0 ? totalBudget / total : 0;

    document.getElementById("analyticsTotal").textContent = total;
    document.getElementById("analyticsActive").textContent = active;
    document.getElementById("analyticsDraft").textContent = draft;

    document.getElementById("averageBudget").textContent =
        formatBudget(average);

    displayBudgetChart();
    displayStatusChart();
}

function displayBudgetChart() {
    const chart = document.getElementById("budgetChart");

    if (campaignsData.length === 0) {
        chart.innerHTML =
            '<p class="empty-message">No campaign budget data available yet.</p>';
        return;
    }

    const maximumBudget = Math.max(
        ...campaignsData.map(campaign => Number(campaign.budget || 0)),
        1
    );

    chart.innerHTML = campaignsData.map(campaign => {
        const budget = Number(campaign.budget || 0);
        const percentage = (budget / maximumBudget) * 100;

        return `
            <div class="budget-row">
                <div class="budget-label">
                    <strong>${escapeHTML(campaign.name)}</strong>
                    <span>${formatBudget(budget)}</span>
                </div>
                <div class="budget-track">
                    <div class="budget-fill"
                        style="width: ${percentage}%"></div>
                </div>
            </div>
        `;
    }).join("");
}

function displayStatusChart() {
    const chart = document.getElementById("statusChart");

    if (campaignsData.length === 0) {
        chart.innerHTML =
            '<p class="empty-message">No campaign status data available yet.</p>';
        return;
    }

    const statuses = {};

    campaignsData.forEach(campaign => {
        const status = campaign.status || "Unknown";
        statuses[status] = (statuses[status] || 0) + 1;
    });

    chart.innerHTML = Object.entries(statuses).map(([status, count]) => `
        <div class="status-row">
            <span>${escapeHTML(status)}</span>
            <strong>${count} campaign(s)</strong>
        </div>
    `).join("");
}

// ==========================================
// MANUAL CAMPAIGN CREATION
// ==========================================

bindIfExists("addCampaignBtn",
    "click",
    () => {
        document.getElementById("campaignForm")
            .classList.remove("hidden");
    }
);

bindIfExists("cancelCampaignBtn",
    "click",
    () => {
        document.getElementById("campaignForm")
            .classList.add("hidden");
    }
);

bindIfExists("saveCampaignBtn",
    "click",
    async () => {
        const name =
            document.getElementById("campaignName").value.trim();

        const description =
            document.getElementById("campaignDescription").value.trim();

        const targetAudience =
            document.getElementById("targetAudience").value.trim();

        const budgetInput =
            document.getElementById("campaignBudget").value;

        if (!name) {
            alert("Please enter a campaign name.");
            return;
        }

        if (budgetInput !== "" && Number(budgetInput) < 0) {
            alert("Budget cannot be negative.");
            return;
        }

        const saveButton =
            document.getElementById("saveCampaignBtn");

        saveButton.disabled = true;
        saveButton.textContent = "Saving...";

        try {
            const response = await authenticatedFetch(
                `${API_URL}/campaigns`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        name,
                        description,
                        target_audience: targetAudience,
                        budget: Number(budgetInput) || 0
                    })
                }
            );

            if (!response.ok) {
                throw new Error("Campaign creation failed.");
            }

            alert("Campaign created successfully!");

            document.getElementById("campaignName").value = "";
            document.getElementById("campaignDescription").value = "";
            document.getElementById("targetAudience").value = "";
            document.getElementById("campaignBudget").value = "";

            document.getElementById("campaignForm")
                .classList.add("hidden");

            await loadCampaigns();

        } catch (error) {
            alert(error.message);
            console.error("Create campaign error:", error);

        } finally {
            saveButton.disabled = false;
            saveButton.textContent = "Save Campaign";
        }
    }
);

// ==========================================
// AI CAMPAIGN GENERATOR
// ==========================================

async function generateCampaign() {
    const product =
        document.getElementById("generatorProduct").value.trim();

    const objective =
        document.getElementById("generatorObjective").value.trim();

    const targetAudience =
        document.getElementById("generatorAudience").value.trim();

    const budgetInput =
        document.getElementById("generatorBudget").value;

    const platform =
        document.getElementById("generatorPlatform").value;

    const generateButton =
        document.getElementById("generateCampaignBtn");

    const status =
        document.getElementById("generatorStatus");

    const resultSection =
        document.getElementById("generatedCampaignResult");
    const placeholder =
        document.getElementById("generatorPlaceholder");

    if (!product || !objective || !targetAudience ||
        !budgetInput || !platform) {
        status.textContent = "Please fill in all campaign details.";
        return;
    }

    if (!Number.isFinite(Number(budgetInput)) ||
        Number(budgetInput) <= 0) {
        status.textContent =
            "Please enter a valid budget greater than zero.";
        return;
    }

    generateButton.disabled = true;
    generateButton.textContent = "Generating...";
    status.textContent =
        "Llama 3.2 is creating your marketing campaign. Please wait...";

    resultSection.classList.add("hidden");

    try {
        const response = await authenticatedFetch(
            `${API_URL}/campaigns/generate`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    product,
                    objective,
                    target_audience: targetAudience,
                    budget: Number(budgetInput),
                    platform
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            throw new Error(
                data.detail || "Campaign generation failed."
            );
        }

        generatedCampaignData = {
            campaign_name: data.campaign_name,
            strategy: data.strategy,
            ad_headline: data.ad_headline,
            ad_description: data.ad_description,
            target_audience: data.target_audience,
            call_to_action: data.call_to_action,
            budget: Number(budgetInput)
        };

        document.getElementById("generatedCampaignName").textContent =
            data.campaign_name;

        document.getElementById("generatedStrategy").textContent =
            data.strategy;

        document.getElementById("generatedHeadline").textContent =
            data.ad_headline;

        document.getElementById("generatedDescription").textContent =
            data.ad_description;

        document.getElementById("generatedTargetAudience").textContent =
            data.target_audience;

        document.getElementById("generatedCTA").textContent =
            data.call_to_action;

        resultSection.classList.remove("hidden");
        if (placeholder) placeholder.classList.add("hidden");
        status.textContent = "Campaign generated successfully!";

    } catch (error) {
        status.textContent = `Error: ${error.message}`;
        console.error("AI Campaign Generator error:", error);

    } finally {
        generateButton.disabled = false;
        generateButton.textContent = "Generate AI Campaign";
    }
}

bindIfExists("generateCampaignBtn",
    "click",
    generateCampaign
);

// Save AI-generated campaign to PostgreSQL.
async function saveGeneratedCampaign() {
    const saveButton =
        document.getElementById("saveGeneratedCampaignBtn");

    const saveStatus =
        document.getElementById("saveCampaignStatus");

    if (!generatedCampaignData) {
        saveStatus.textContent = "Please generate a campaign first.";
        return;
    }

    saveButton.disabled = true;
    saveButton.textContent = "Saving...";
    saveStatus.textContent = "Saving campaign to PostgreSQL...";

    const description = `
Strategy: ${generatedCampaignData.strategy}

Advertisement Headline: ${generatedCampaignData.ad_headline}

Advertisement Description: ${generatedCampaignData.ad_description}

Call to Action: ${generatedCampaignData.call_to_action}
    `.trim();

    try {
        const response = await authenticatedFetch(
            `${API_URL}/campaigns`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    name: generatedCampaignData.campaign_name,
                    description,
                    target_audience: generatedCampaignData.target_audience,
                    budget: generatedCampaignData.budget
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            throw new Error(
                data.detail || "Campaign saving failed."
            );
        }

        saveStatus.textContent = "Campaign saved successfully!";

        await loadCampaigns();

        generatedCampaignData = null;
        saveButton.textContent = "Campaign Saved";

    } catch (error) {
        saveStatus.textContent = `Error: ${error.message}`;
        console.error("Save generated campaign error:", error);

        saveButton.disabled = false;
        saveButton.textContent = "Save Generated Campaign";
    }
}

bindIfExists("saveGeneratedCampaignBtn",
    "click",
    saveGeneratedCampaign
);

// ==========================================
// PDF UPLOAD
// ==========================================

async function loadPdfDocuments(preferredFileHash = "") {
    const select = document.getElementById("pdfDocumentSelect");
    const deleteButton = document.getElementById("deletePdfBtn");
    const status = document.getElementById("documentStatus");
    const selectedFileHash = preferredFileHash || select.value;

    try {
        const response = await authenticatedFetch(`${API_URL}/documents`);
        const documents = await response.json();

        if (!response.ok) {
            throw new Error(documents.detail || "Could not load uploaded PDFs.");
        }

        select.replaceChildren(new Option("All uploaded PDFs", ""));

        for (const pdf of documents) {
            select.add(new Option(pdf.filename, pdf.file_hash));
        }

        select.value = documents.some(
            document => document.file_hash === selectedFileHash
        ) ? selectedFileHash : "";
        updatePdfDeleteButton();
        status.textContent = documents.length
            ? `${documents.length} PDF${documents.length === 1 ? "" : "s"} available.`
            : "No PDFs uploaded yet.";

    } catch (error) {
        deleteButton.hidden = true;
        status.textContent = `Could not load uploaded PDFs: ${error.message}`;
        console.error("PDF list error:", error);
    }
}

function updatePdfDeleteButton() {
    const select = document.getElementById("pdfDocumentSelect");
    const deleteButton = document.getElementById("deletePdfBtn");
    const hasSelectedPdf = Boolean(select.value);

    deleteButton.hidden = !hasSelectedPdf;
    deleteButton.style.display = hasSelectedPdf ? "inline-flex" : "none";
    deleteButton.disabled = !hasSelectedPdf;
    deleteButton.textContent = "Delete";
    deleteButton.dataset.fileHash = select.value;
    deleteButton.dataset.filename =
        select.options[select.selectedIndex]?.text || "";
}

async function deleteSelectedPDF() {
    const deleteButton = document.getElementById("deletePdfBtn");
    const status = document.getElementById("documentStatus");
    const { fileHash, filename } = deleteButton.dataset;

    if (!fileHash) {
        return;
    }

    if (!window.confirm(`Delete "${filename}"? This cannot be undone.`)) {
        return;
    }

    deleteButton.disabled = true;
    deleteButton.textContent = "Deleting...";
    status.textContent = `Deleting ${filename}...`;

    try {
        const response = await authenticatedFetch(
            `${API_URL}/documents/${encodeURIComponent(fileHash)}`,
            { method: "DELETE" }
        );
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.detail || "Could not delete the PDF.");
        }

        await loadPdfDocuments();
        status.textContent = `${data.filename} was deleted.`;
    } catch (error) {
        status.textContent = `Could not delete PDF: ${error.message}`;
        console.error("PDF delete error:", error);
        deleteButton.disabled = false;
        deleteButton.textContent = "Delete";
    }
}

bindIfExists("pdfDocumentSelect",
    "change",
    updatePdfDeleteButton
);
bindIfExists("deletePdfBtn",
    "click",
    deleteSelectedPDF
);

async function uploadPDF() {
    const fileInput = document.getElementById("pdfFile");
    const uploadButton = document.getElementById("uploadPdfBtn");
    const uploadStatus = document.getElementById("uploadStatus");

    const file = fileInput.files[0];

    if (!file) {
        uploadStatus.textContent = "Please select a PDF file first.";
        return;
    }

    if (!file.name.toLowerCase().endsWith(".pdf")) {
        uploadStatus.textContent = "Only PDF files are allowed.";
        return;
    }

    const formData = new FormData();
    formData.append("file", file);

    uploadButton.disabled = true;
    uploadButton.textContent = "Uploading...";
    uploadStatus.textContent =
        "Uploading and processing your PDF...";

    try {
        const response = await authenticatedFetch(`${API_URL}/documents/upload`, {
            method: "POST",
            body: formData
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.detail || "PDF upload failed.");
        }

        uploadStatus.textContent = data.already_exists
            ? `${data.filename} is already available in the PDF index.`
            : `Success! ${data.filename} processed into ${data.chunks} text chunks.`;

        await loadPdfDocuments(data.file_hash);
        fileInput.value = "";

    } catch (error) {
        uploadStatus.textContent = `Upload failed: ${error.message}`;
        console.error("PDF upload error:", error);

    } finally {
        uploadButton.disabled = false;
        uploadButton.textContent = "Upload PDF";
    }
}

bindIfExists("uploadPdfBtn",
    "click",
    uploadPDF
);

// ==========================================
// AI CHATBOT
// ==========================================

async function sendMessage() {
    const input = document.getElementById("userMessage");
    const chatBox = document.getElementById("chatBox");
    const sendButton = document.getElementById("sendBtn");

    const message = input.value.trim();

    if (!message || sendButton.disabled) {
        return;
    }

    const userMessage = document.createElement("div");
    userMessage.className = "user-message";
    userMessage.textContent = message;

    chatBox.appendChild(userMessage);
    input.value = "";

    const loadingMessage = document.createElement("div");
    loadingMessage.className = "bot-message";
    loadingMessage.textContent = "AI is thinking...";

    chatBox.appendChild(loadingMessage);

    sendButton.disabled = true;
    sendButton.textContent = "Thinking...";

    chatBox.scrollTop = chatBox.scrollHeight;

    try {
        const response = await authenticatedFetch(`${API_URL}/chat`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                user_message: message,
                document_hash:
                    document.getElementById("pdfDocumentSelect").value || null
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(
                data.detail || data.message || "AI request failed."
            );
        }

        const documentStatus = data.used_documents
            ? "PDF context used"
            : "No PDF context retrieved";
        loadingMessage.textContent =
            `${documentStatus}\n\n${data.ai_response}`;

    } catch (error) {
        loadingMessage.textContent = `Unable to get an AI response: ${error.message}`;

        console.error("Chat error:", error);

    } finally {
        sendButton.disabled = false;
        sendButton.textContent = "Send";
        chatBox.scrollTop = chatBox.scrollHeight;
    }
}

bindIfExists("sendBtn",
    "click",
    sendMessage
);

bindIfExists("userMessage",
    "keydown",
    event => {
        if (event.key === "Enter") {
            sendMessage();
        }
    }
);

// ==========================================
// ANALYTICS REFRESH
// ==========================================

bindIfExists("refreshAnalyticsBtn",
    "click",
    async () => {
        await loadCampaigns();
    }
);

// ==========================================
// START APPLICATION
// ==========================================

checkLogin();
