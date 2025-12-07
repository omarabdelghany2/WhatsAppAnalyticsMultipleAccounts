#!/usr/bin/env python3
"""
Script to login and make user admin
"""
import requests
import json

# Configuration
BASE_URL = "https://web-production-5dffa.up.railway.app"
EMAIL = "omarAbdelghany56@gmail.com"
PASSWORD = "omarAbdelghany56@gmail.com"

def login():
    """Login and get token"""
    print("🔐 Logging in...")

    login_url = f"{BASE_URL}/api/auth/login"
    payload = {
        "email": EMAIL,
        "password": PASSWORD
    }

    try:
        response = requests.post(login_url, json=payload)
        response.raise_for_status()
        data = response.json()

        if data.get("success"):
            token = data.get("token")
            user = data.get("user", {})
            print(f"✅ Login successful! Welcome {user.get('username', 'User')}")
            return token
        else:
            print(f"❌ Login failed: {data.get('error', 'Unknown error')}")
            return None
    except requests.exceptions.RequestException as e:
        print(f"❌ Login request failed: {e}")
        return None

def make_admin(token):
    """Make user admin"""
    print("\n🛡️  Making user admin...")

    admin_url = f"{BASE_URL}/api/admin/make-me-admin"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }

    try:
        response = requests.post(admin_url, headers=headers)
        response.raise_for_status()
        data = response.json()

        if data.get("success"):
            print(f"✅ {data.get('message', 'Success!')}")
            print("\n📝 Next steps:")
            print("1. Logout from the web app")
            print("2. Login again at: https://web-production-5dffa.up.railway.app/login")
            print("3. Access dashboard at: https://web-production-5dffa.up.railway.app/dashboard")
            return True
        else:
            print(f"❌ Failed to make admin: {data.get('error', 'Unknown error')}")
            return False
    except requests.exceptions.RequestException as e:
        print(f"❌ Make admin request failed: {e}")
        return False

def main():
    print("=" * 60)
    print("WhatsApp Analytics - Make User Admin")
    print("=" * 60)

    # Step 1: Login
    token = login()
    if not token:
        print("\n❌ Failed to login. Exiting.")
        return

    # Step 2: Make admin
    success = make_admin(token)

    if success:
        print("\n" + "=" * 60)
        print("🎉 All done! You are now an admin.")
        print("=" * 60)
    else:
        print("\n❌ Failed to complete the process.")

if __name__ == "__main__":
    main()
