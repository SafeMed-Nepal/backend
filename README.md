# SafeMed Backend API Server 🚀

This is the Express API server for SafeMed Nepal. It acts as the secure gateway to the Supabase PostgreSQL database, handles JWT token validation for medical staff, updates profiles, logs audits, and manages Nodemailer SMTP email alerts.

---

## ⚙️ Configuration & Environment Variables

Create a `.env` file in the root of the `backend/` directory with the following variables:

```properties
# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
# service_role key is required to bypass Row-Level Security policies for administrative tasks
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Server Port & CORS
PORT=3001
ALLOWED_ORIGIN=http://localhost:5173

# Admin Recipient for Reviewer Applications
CONTACT_EMAIL=rishavc957@gmail.com

# SMTP Configurations for Gmail Onboarding (Optional - uses mock simulation if empty)
SMTP_SERVICE=gmail
SMTP_USER=your-gmail-address@gmail.com
SMTP_PASS=xxxx-xxxx-xxxx-xxxx  # 16-character Google App Password
```

---

## 🔒 Authentication & Authorization

All state-modifying requests require JWT authorization.
* **Header format**: `Authorization: Bearer <access_token>`
* **Validation process**: The token is decoded and verified against Supabase Auth (`supabase.auth.getUser()`).
* **Role Check**: Endpoints modifying remedies verify if the user's role is `admin` or `doctor` in the database.

---

## 🛣️ API Endpoints

### 1. Remedies Router (`/api/remedies`)

| Method | Endpoint | Description | Auth Required |
|:---|:---|:---|:---|
| **GET** | `/api/remedies` | Fetch paginated remedies. Supports filter by `symptom` and admin preview of drafts. | No |
| **GET** | `/api/remedies/:id` | Fetch detailed information of a single remedy. | No |
| **POST** | `/api/remedies` | Create a new remedy draft. | Yes |
| **PATCH** | `/api/remedies/:id` | Modify remedy title, warnings, ingredients, or steps. | Yes |
| **DELETE** | `/api/remedies/:id` | Permanently delete a remedy from the database. | Yes (Admin Only) |
| **PATCH** | `/api/remedies/:id/status` | Update status (`approved`, `revision_required`, `rejected`, `published`) and log notes. | Yes |

#### Payload Examples:
* **POST `/api/remedies`**:
  ```json
  {
    "title_en": "Lemon Water for Sore Throat",
    "title_ne": "घाँटी दुख्दा कागती पानी",
    "symptom": "sore_throat",
    "ingredients_en": ["Lemon", "Warm Water", "Honey"],
    "ingredients_ne": ["कागती", "मनतातो पानी", "मह"],
    "steps_en": ["Squeeze half a lemon into warm water.", "Mix 1 spoon honey.", "Drink twice a day."],
    "steps_ne": ["मनतातो पानीमा आधा कागती निचोर्नुहोस्।", "एक चम्चा मह मिसाउनुहोस्।", "दिनको दुई पटक पिउनुहोस्।"]
  }
  ```

---

### 2. Clinical Reviews Router (`/api/remedies/:id/reviews`)

| Method | Endpoint | Description | Auth Required |
|:---|:---|:---|:---|
| **GET** | `/api/remedies/:id/reviews` | Retrieve verification audit history and doctor comments. | No |
| **POST** | `/api/remedies/:id/reviews` | Log a medical professional review vote and comments. | Yes |

#### Payload Example:
* **POST `/api/remedies/:id/reviews`**:
  ```json
  {
    "status": "approved",
    "comments": "The ingredients are safe. Remind patients not to use boiling water to avoid destroying honey nutrients."
  }
  ```

---

### 3. Profiles Router (`/api/profile`)

| Method | Endpoint | Description | Auth Required |
|:---|:---|:---|:---|
| **PATCH** | `/api/profile` | Update doctor/admin profile metadata (name, credentials, avatar URL). | Yes |

#### Payload Example:
* **PATCH `/api/profile`**:
  ```json
  {
    "full_name": "Dr. Subhash Thapa",
    "credentials": "MBBS, MD (Internal Medicine)",
    "avatar_url": "https://example.com/avatar.png"
  }
  ```

---

### 4. Reviewer Onboarding Application (`/api/contact`)

| Method | Endpoint | Description | Auth Required |
|:---|:---|:---|:---|
| **POST** | `/api/contact` | Submit a request to become a medical reviewer. logs record and dispatches SMTP email. | No |

#### Payload Example:
```json
{
  "name": "Dr. Alina Shrestha",
  "email": "alina@hospital.org",
  "credentials": "MD (Pediatrics)",
  "organization": "Kanti Children's Hospital",
  "nmc_number": "18492",
  "credential_link": "https://drive.google.com/drive/folders/your-credentials-id",
  "message": "Interested in reviewing child healthcare remedy instructions."
}
```

---

### 5. Notifications Router (`/api/notifications`)

| Method | Endpoint | Description | Auth Required |
|:---|:---|:---|:---|
| **GET** | `/api/notifications` | Fetch the current user's last 50 notifications. | Yes |
| **PATCH** | `/api/notifications/:id` | Toggle status (`read` or `unread`) of a single notification. | Yes |
| **POST** | `/api/notifications/mark-all-read` | Mark all unread notifications as read. | Yes |

#### Payload Examples:
* **PATCH `/api/notifications/:id`**:
  ```json
  {
    "status": "read"
  }
  ```

---

## 📧 Email Notification Service (SMTP)

* **Mode 1: Mock/Simulation (Default)**:
  If `SMTP_USER` and `SMTP_PASS` are absent, the server automatically boots in developer preview mode. Submitted applications will output a temporary mail preview link in the console (e.g. via `Ethereal Email`) so you can inspect the email body in your browser without entering credentials.
* **Mode 2: Live Mail Delivery**:
  When SMTP credentials are set, Nodemailer connects to Gmail and immediately dispatches professional, HTML-formatted reviewer applications to the address specified in `CONTACT_EMAIL`.
