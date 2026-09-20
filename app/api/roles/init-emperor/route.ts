import { auth, assignRoleToUser, findOrCreateRole } from "@/lib/auth";
import { createDb } from "@/lib/db";
import { roles, userRoles } from "@/lib/schema";
import { ROLES } from "@/lib/permissions";
import { eq } from "drizzle-orm";

export const runtime = "edge";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "未授权" }, { status: 401 });
  }

  const db = createDb();

  const emperorRole = await db.query.roles.findFirst({
    where: eq(roles.name, ROLES.EMPEROR),
    with: {
      userRoles: true,
    },
  });

  if (emperorRole && emperorRole.userRoles.length > 0) {
    return Response.json({ error: "已存在皇帝, 谋反将被处死" }, { status: 400 });
  }

  try {
    const currentUserRole = await db.query.userRoles.findFirst({
      where: eq(userRoles.userId, session.user.id),
      with: {
        role: true,
      },
    });

    if (currentUserRole?.role.name === ROLES.EMPEROR) {
      return Response.json({ message: "你已经是皇帝了" });
    }

    const role = await findOrCreateRole(db, ROLES.EMPEROR);
    // Database triggers enforce the singleton even when requests race.
    await assignRoleToUser(db, session.user.id, role.id);

    return Response.json({ message: "登基成功，你已成为皇帝" });
  } catch (error) {
    if (String(error).includes("single_emperor")) {
      return Response.json({ error: "已存在皇帝" }, { status: 409 });
    }
    console.error("Failed to initialize emperor:", error);
    return Response.json(
      { error: "登基称帝失败" },
      { status: 500 }
    );
  }
} 