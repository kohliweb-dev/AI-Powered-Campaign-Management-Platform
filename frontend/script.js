
const API_URL = "http://127.0.0.1:8001";

let campaignsData = [];
let semanticSearchResults = null;
let searchRequestNumber = 0;
let searchDebounceTimer = null;
let generatedCampaignData = null;
let editingCampaignId = null;
let currentUser = null;

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
    document.getElementById("authScreen").style.display = "flex";
    document.getElementById("appContainer").style.display = "none";
    document.getElementById("assistantToggleBtn").style.display = "none";
}

function showDashboard(user) {
    currentUser = user;

    document.getElementById("authScreen").style.display = "none";
    document.getElementById("appContainer").style.display = "";
    document.getElementById("assistantToggleBtn").style.display = "";

    document.getElementById("profileName").textContent = user.username;
    document.getElementById("profileRole").textContent = user.role;
    document.getElementById("profileAvatar").textContent =
        user.username.charAt(0).toUpperCase();

    const adminUsersNav = document.getElementById("adminUsersNav");
    const userManagement = document.getElementById("userManagement");

    const isAdmin = user.role === "admin";

    adminUsersNav.classList.toggle("hidden", !isAdmin);
    userManagement.classList.add("hidden");

    if (isAdmin) {
        loadUsers();
    }

    loadCampaigns();
}

function switchAuthMode() {
    authMode = authMode === "login" ? "register" : "login";

    document.getElementById("authTitle").textContent =
        authMode === "login" ? "Login to CampaignAI" : "Create Account";

    document.getElementById("usernameGroup").style.display =
        authMode === "register" ? "block" : "none";

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

document.getElementById("authSwitchBtn").addEventListener(
    "click",
    switchAuthMode
);

document.getElementById("authForm").addEventListener(
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

// Logout
document.getElementById("logoutBtn").addEventListener("click", () => {
    localStorage.removeItem("access_token");
    currentUser = null;
    location.reload();
});

// Restore existing login session
async function checkLogin() {
    const token = localStorage.getItem("access_token");

    if (!token) {
        showAuthScreen();
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
        showAuthScreen();
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
                            ${isCurrentUser ? "disabled" : ""}
                        >
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
                                : `
                                    <button
                                        type="button"
                                        class="save-user-role-btn"
                                        data-user-id="${user.id}">
                                        Save Role
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

document.getElementById("refreshUsersBtn").addEventListener(
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

document.getElementById("usersTableBody").addEventListener(
    "click",
    async function(event) {
        const button = event.target.closest(".save-user-role-btn");

        if (!button) return;

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
        displayCampaigns();

    } catch (error) {
        campaignList.innerHTML =
            '<p class="empty-message">Unable to load campaigns. Check FastAPI.</p>';

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

    document.getElementById("totalCampaigns").textContent = total;
    document.getElementById("activeCampaigns").textContent = active;
    document.getElementById("totalBudget").textContent =
        formatBudget(totalBudget);

    updateAnalytics();
}

// Display campaigns, including semantic search results.
function displayCampaigns() {
    const campaignList = document.getElementById("campaignList");

    const searchInput = document.getElementById("campaignSearch");
    const statusFilter = document.getElementById("campaignStatusFilter");

    const searchText = searchInput.value.toLowerCase().trim();
    const selectedStatus = statusFilter.value;

    const sourceCampaigns =
        semanticSearchResults !== null
            ? semanticSearchResults
            : campaignsData;

    const filteredCampaigns = sourceCampaigns.filter(campaign => {
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

    if (filteredCampaigns.length === 0) {
        campaignList.innerHTML = `
            <p class="empty-message">No matching campaigns found.</p>
        `;
        return;
    }

    campaignList.innerHTML = filteredCampaigns.map(campaign => `
        <div class="campaign-item">
            <div>
                <h3>${escapeHTML(campaign.name)}</h3>
                <p>${escapeHTML(
                    campaign.target_audience || "No target audience"
                )}</p>
                <p>Budget: ${formatBudget(campaign.budget)}</p>
            </div>

            <div class="campaign-actions">
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
            </div>
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

document.getElementById("campaignSearch").addEventListener(
    "input",
    () => {
        clearTimeout(searchDebounceTimer);

        searchDebounceTimer = setTimeout(() => {
            performCampaignSearch();
        }, 500);
    }
);

document.getElementById("campaignStatusFilter").addEventListener(
    "change",
    displayCampaigns
);

// Handle Edit and Delete campaign buttons.
document.getElementById("campaignList").addEventListener(
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
document.getElementById("editCampaignForm").addEventListener(
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

document.getElementById("cancelEditCampaignBtn").addEventListener(
    "click",
    () => {
        editingCampaignId = null;

        document.getElementById("editCampaignForm")
            .classList.add("hidden");

        document.getElementById("editCampaignStatus").textContent = "";
    }
);

// ==========================================
// ANALYTICS
// ==========================================

function updateAnalytics() {
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

document.getElementById("addCampaignBtn").addEventListener(
    "click",
    () => {
        document.getElementById("campaignForm")
            .classList.remove("hidden");
    }
);

document.getElementById("cancelCampaignBtn").addEventListener(
    "click",
    () => {
        document.getElementById("campaignForm")
            .classList.add("hidden");
    }
);

document.getElementById("saveCampaignBtn").addEventListener(
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
        status.textContent = "Campaign generated successfully!";

    } catch (error) {
        status.textContent = `Error: ${error.message}`;
        console.error("AI Campaign Generator error:", error);

    } finally {
        generateButton.disabled = false;
        generateButton.textContent = "Generate AI Campaign";
    }
}

document.getElementById("generateCampaignBtn").addEventListener(
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

document.getElementById("saveGeneratedCampaignBtn").addEventListener(
    "click",
    saveGeneratedCampaign
);

// ==========================================
// PDF UPLOAD
// ==========================================

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

        uploadStatus.textContent =
            `Success! ${data.filename} processed into ${data.chunks} text chunks.`;

        fileInput.value = "";

    } catch (error) {
        uploadStatus.textContent = `Upload failed: ${error.message}`;
        console.error("PDF upload error:", error);

    } finally {
        uploadButton.disabled = false;
        uploadButton.textContent = "Upload PDF";
    }
}

document.getElementById("uploadPdfBtn").addEventListener(
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
                user_message: message
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(
                data.detail || data.message || "AI request failed."
            );
        }

        loadingMessage.textContent = data.ai_response;

    } catch (error) {
        loadingMessage.textContent = `Unable to get an AI response: ${error.message}`;

        console.error("Chat error:", error);

    } finally {
        sendButton.disabled = false;
        sendButton.textContent = "Send";
        chatBox.scrollTop = chatBox.scrollHeight;
    }
}

document.getElementById("sendBtn").addEventListener(
    "click",
    sendMessage
);

document.getElementById("userMessage").addEventListener(
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

document.getElementById("refreshAnalyticsBtn").addEventListener(
    "click",
    async () => {
        await loadCampaigns();
    }
);

// ==========================================
// AI ASSISTANT RESIZE AND NAVIGATION
// ==========================================

const navLinks = document.querySelectorAll(".nav-link");
const assistantPanel = document.getElementById("assistant");

const assistantToggleButton =
    document.getElementById("assistantToggleBtn");

const assistantResizeHandle =
    document.getElementById("assistantResizeHandle");

function setAssistantWidth(width) {
    const isMobile =
        window.matchMedia("(max-width: 560px)").matches;

    const edgeSpace = isMobile ? 20 : 40;

    const availableWidth = Math.max(
        0,
        document.documentElement.clientWidth - edgeSpace
    );

    const maximumWidth = Math.min(1100, availableWidth);

    const minimumWidth = Math.min(
        isMobile ? 300 : 360,
        maximumWidth
    );

    const nextWidth = Math.round(
        Math.min(maximumWidth, Math.max(minimumWidth, width))
    );

    assistantPanel.style.width = `${nextWidth}px`;

    assistantResizeHandle.setAttribute(
        "aria-valuemax",
        String(maximumWidth)
    );

    assistantResizeHandle.setAttribute(
        "aria-valuemin",
        String(minimumWidth)
    );

    assistantResizeHandle.setAttribute(
        "aria-valuenow",
        String(nextWidth)
    );
}

assistantResizeHandle.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;

    event.preventDefault();

    assistantPanel.classList.add("is-resizing");
    document.body.classList.add("assistant-resizing");

    assistantResizeHandle.setPointerCapture(event.pointerId);
});

assistantResizeHandle.addEventListener("pointermove", event => {
    if (!assistantResizeHandle.hasPointerCapture(event.pointerId)) {
        return;
    }

    const panelRight =
        document.documentElement.clientWidth -
        Number.parseFloat(getComputedStyle(assistantPanel).right);

    setAssistantWidth(panelRight - event.clientX);
});

function stopAssistantResize(event) {
    if (!assistantResizeHandle.hasPointerCapture(event.pointerId)) {
        return;
    }

    assistantResizeHandle.releasePointerCapture(event.pointerId);

    assistantPanel.classList.remove("is-resizing");
    document.body.classList.remove("assistant-resizing");
}

assistantResizeHandle.addEventListener("pointerup", stopAssistantResize);
assistantResizeHandle.addEventListener("pointercancel", stopAssistantResize);

assistantResizeHandle.addEventListener("keydown", event => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
    }

    event.preventDefault();

    const currentWidth =
        assistantPanel.getBoundingClientRect().width;

    const direction = event.key === "ArrowLeft" ? 1 : -1;

    setAssistantWidth(currentWidth + direction * 32);
});

window.addEventListener("resize", () => {
    if (assistantPanel.style.width) {
        setAssistantWidth(
            assistantPanel.getBoundingClientRect().width
        );
    }
});

function openAssistant() {
    assistantPanel.classList.remove("hidden");

    assistantToggleButton.setAttribute("aria-expanded", "true");
    assistantToggleButton.setAttribute("aria-label", "Close AI assistant");
    assistantToggleButton.title = "Close assistant";
}

function closeAssistant() {
    assistantPanel.classList.add("hidden");

    assistantToggleButton.setAttribute("aria-expanded", "false");
    assistantToggleButton.setAttribute("aria-label", "Open AI assistant");
    assistantToggleButton.title = "Chat with AI assistant";
}

assistantToggleButton.addEventListener("click", () => {
    if (assistantPanel.classList.contains("hidden")) {
        openAssistant();
        document.getElementById("userMessage").focus();
    } else {
        closeAssistant();
    }
});

document.getElementById("closeAssistantBtn").addEventListener(
    "click",
    closeAssistant
);

document.addEventListener("keydown", event => {
    if (
        event.key === "Escape" &&
        !assistantPanel.classList.contains("hidden")
    ) {
        closeAssistant();
        assistantToggleButton.focus();
    }
});

navLinks.forEach(link => {
    link.addEventListener("click", event => {
        const target = link.getAttribute("href");

        navLinks.forEach(item => {
            item.classList.remove("active");
        });

        link.classList.add("active");

        if (target === "#assistant") {
            event.preventDefault();

            openAssistant();
            document.getElementById("userMessage").focus();
            return;
        }

        if (target === "#userManagement") {
            if (!currentUser || currentUser.role !== "admin") {
                event.preventDefault();
                return;
            }

            document.getElementById("userManagement")
                .classList.remove("hidden");

            loadUsers();
        }
    });
});

// ==========================================
// START APPLICATION
// ==========================================

checkLogin();
