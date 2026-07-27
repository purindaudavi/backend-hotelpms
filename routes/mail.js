
// const express = require('express');
// const router = express.Router();
// const nodemailer = require('nodemailer');


// const transporter = nodemailer.createTransport({
//     host:"mail.dms.lk",
//     port: 465,
//     secure: true,
//     auth: {
//         user: "pms@dms.lk",
//         pass: "REDACTED"
//     }
// });


// router.post("/mail/test", async (req, res) => {
//     const {mail, message} = req.body;
//     try{
//         await transporter.sendMail(
//             {
//                 from : "pms@dms.lk",
//                 to : mail,
//                 text : message
//             }
//         );  
//         return res.status(201).json({message : "email sent!"})
//     }catch(error){
//         console.log(error);
//         return res.status(500).json({message : "something went wrong!"})
//     }
// })


// router.get("/mail/test", async (req, res) => {
    
//     try{
//         await transporter.sendMail(
//             {
//                 from : "pms@dms.lk",
//                 to : "depraba.dp@gmail.com",
//                 text : "This is a test email"
//             }
//         );  
//         return res.status(201).json({message : "email sent!"})
//     }catch(error){
//         console.log(error);
//         return res.status(500).json({message : "something went wrong!"})
//     }
// })



// module.exports = router;




// ------------------------------------




const express = require("express");
const nodemailer = require("nodemailer");

const router = express.Router();

const transporter = nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: Number(process.env.MAIL_PORT),
    secure: true,
    auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASSWORD
    }
});

function createDeliveryReport(info) {
    const accepted = (info.accepted || []).map(String);
    const rejected = (info.rejected || []).map(String);
    const pending = (info.pending || []).map(String);
    const status = rejected.length && !accepted.length
        ? "rejected"
        : pending.length
            ? "queued"
            : "accepted";

    return {
        status,
        messageId: info.messageId || "",
        response: info.response || "",
        accepted,
        rejected,
        pending
    };
}

async function sendHotelMail(options) {
    const info = await transporter.sendMail(options);
    const delivery = createDeliveryReport(info);
    console.info("SMTP delivery handoff", {
        to: options.to,
        subject: options.subject,
        ...delivery
    });
    return delivery;
}

const emailSubjects = {
    confirmation: "Booking Confirmation",
    "check-in": "Hotel Check-in",
    "check-out": "Hotel Check-out",
    cancellation: "Booking Cancellation",
    reminder: "Booking Reminder",
    "no-show": "Reservation No-show",
    general: "Hotel Information"
};



 
function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function createEmailTemplate({
    title,
    name,
    message,
    color = "#475569",
    details = [],
    contactTitle = "Please contact us",
    contactMessage = "If you need help, please contact our hotel."
}) {
    const detailRows = details
        .map(
            ({ label, value }) => `
                <tr>
                    <td style="
                        padding: 14px 0;
                        border-bottom: 1px solid #dbe2ea;
                        color: #334155;
                        font-size: 17px;
                    ">
                        <strong>${escapeHtml(label)}:</strong>
                        ${escapeHtml(value)}
                    </td>
                </tr>
            `
        )
        .join("");

    return `
<!DOCTYPE html>
<html lang="en">
<body style="
    margin: 0;
    padding: 25px;
    background-color: #f1f5f9;
    font-family: Arial, Helvetica, sans-serif;
">
    <table
        role="presentation"
        width="100%"
        cellspacing="0"
        cellpadding="0"
        border="0"
    >
        <tr>
            <td align="center">
                <table
                    role="presentation"
                    width="100%"
                    cellspacing="0"
                    cellpadding="0"
                    border="0"
                    style="
                        max-width: 700px;
                        background-color: #ffffff;
                        border-radius: 15px;
                        overflow: hidden;
                    "
                >
                    <!-- Header -->
                    <tr>
                        <td
                            align="center"
                            style="
                                padding: 55px 30px;
                                background-color: ${color};
                                color: #ffffff;
                            "
                        >
                            <h1 style="
                                margin: 0 0 20px;
                                font-size: 34px;
                            ">
                                ${escapeHtml(title)}
                            </h1>

                            <p style="
                                margin: 0 0 35px;
                                font-size: 20px;
                            ">
                                Dear ${escapeHtml(name)},
                            </p>

                            <p style="
                                margin: 0;
                                font-size: 17px;
                                line-height: 27px;
                            ">
                                ${escapeHtml(message)}
                            </p>
                        </td>
                    </tr>

                    <!-- Details -->
                    <tr>
                        <td style="padding: 35px 40px;">
                            <h2 style="
                                margin: 0 0 20px;
                                color: #111827;
                                font-size: 23px;
                            ">
                                Reservation details
                            </h2>

                            <table
                                role="presentation"
                                width="100%"
                                cellspacing="0"
                                cellpadding="0"
                                border="0"
                            >
                                ${detailRows}
                            </table>
                        </td>
                    </tr>

                    <!-- Contact -->
                    <tr>
                        <td style="
                            padding: 30px 40px;
                            background-color: #f8fafc;
                            color: #334155;
                        ">
                            <h2 style="
                                margin: 0 0 17px;
                                color: #111827;
                                font-size: 21px;
                            ">
                                ${escapeHtml(contactTitle)}
                            </h2>

                            <p style="
                                margin: 0;
                                font-size: 16px;
                                line-height: 25px;
                            ">
                                ${escapeHtml(contactMessage)}
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
    `;
}







router.post("/mail/confirmation", async (req, res) => {
     const { mail, name, checkin , checkout , duration , rooms ,
         payment ,total , sperequest } = req.body;

    if (!mail || !name || !checkin || !checkout || !duration || !rooms || !payment || !total || !sperequest) {
        return res.status(400).json({
            message: "mail, name ,checkin and checkout ,duration ,rooms ,payment ,total and sperequest are required"
        });
    }

        const html = createEmailTemplate({
        title: "BOOKING CONFIRMATION",
        name,
        message:
            `This is your confirmation email from Ronaka Airport Transit Hotel.`,
        color: "#04ff00",

        details: [
            {
                label: "check-in",
                value: checkin
            },
            {
                label: "check-out",
                value: checkout
            },
            {
                label: "Duration",
                value: duration
            },
            {
                label: "Rooms",
                value: rooms
            },
            {
                label: "Payment",
                value: payment
            },
            {
                label: "total",
                value:`LKR ${total}`
            },
            {
                label: "special requests",
                value: sperequest
            }
            
        ],

        contactTitle: "Sign-off",
        contactMessage:
            "We look forward to welcoming you! If you have any questions, contact Ronaka Airport Transit Hotel at +94 70 355 1340."
    });

    try {
        const delivery = await sendHotelMail({
            from: process.env.MAIL_USER,
            to: mail,
            subject: "Booking Confirmation",
            text: `Dear ${name}, booking ${checkin}. Check-in: ${checkin}, check-out: ${checkout}, duration: ${duration}, rooms: ${rooms}, payment: ${payment}, total: LKR ${total}, special requests: ${sperequest}.`,
            html
        });

        return res.status(200).json({
            message: "confirmation email accepted by SMTP server",
            delivery
        });
    } catch (error) {
        console.error(error); 

        return res.status(500).json({
            message: "confirmation email could not be sent"
        });
    }




    
});




router.post("/mail/check-in", async (req, res) => {
     const { mail, name, reservation ,checkin , checkout , nights , rooms ,
          sperequest ,timelocation , wifiname ,wifipwd} = req.body;

    if (!mail || !name || !reservation || !checkin || !checkout || !nights || !rooms || !sperequest || !timelocation ) {
        return res.status(400).json({
            message: "mail, name ,reservation ,checkin and checkout ,nights ,rooms ,sperequest and timelocation are required"
        });
    }

    const html = createEmailTemplate({
        title: "WELCOME - CHECK-IN",
        name,
        message: `Your reservation ${reservation} is ready for check-in.`,
        color: "#0f766e",
        details: [
            { label: "Reservation", value: reservation },
            { label: "Check-in", value: checkin },
            { label: "Check-out", value: checkout },
            { label: "Nights", value: nights },
            { label: "Rooms", value: rooms },
            { label: "Time and location", value: timelocation },
            ...(wifiname ? [{ label: "Wi-Fi network", value: wifiname }] : []),
            ...(wifipwd ? [{ label: "Wi-Fi password", value: wifipwd }] : []),
            { label: "Special requests", value: sperequest }
        ],
        contactTitle: "Welcome to Ronaka Airport Transit Hotel",
        contactMessage: "If you need assistance during your stay, contact our hotel at +94 70 355 1340."
    });

    try {
        const delivery = await sendHotelMail({
            from: process.env.MAIL_USER,
            to: mail,
            subject: "Check-in Information",
            text: `Dear ${name}, reservation ${reservation} has been confirmed. Check-in: ${checkin}, Check-out: ${checkout}, 
            Nights: ${nights}, Rooms: ${rooms}, Special Requests: ${sperequest}, Time and Location: ${timelocation}.`,
            html
        });

        return res.status(200).json({
            message: "check-in email accepted by SMTP server",
            delivery
        });
    } catch (error) {
        console.error(error);

        return res.status(500).json({
            message: "check-in email could not be sent"
        });
    }




    
});




router.post("/mail/check-out", async (req, res) => {
     const { mail, name, reservation ,checkin , checkout , duration , finaltotal ,
          payment, } = req.body;

    if (!mail || !name || !reservation || !checkin || !checkout || !duration || !finaltotal || !payment ) {
        return res.status(400).json({
            message: "mail, name ,reservation ,checkin and checkout ,duration ,finaltotal ,payment are required"
        });
    }

    const html = createEmailTemplate({
        title: "THANK YOU FOR STAYING WITH US",
        name,
        message: `Check-out details for reservation ${reservation}.`,
        color: "#2563eb",
        details: [
            { label: "Reservation", value: reservation },
            { label: "Check-in", value: checkin },
            { label: "Check-out", value: checkout },
            { label: "Duration", value: duration },
            { label: "Final total", value: `LKR ${finaltotal}` },
            { label: "Payment", value: payment }
        ],
        contactTitle: "We hope to welcome you again",
        contactMessage: "If you have questions about your final bill, contact Ronaka Airport Transit Hotel at +94 70 355 1340."
    });

    try {
        const delivery = await sendHotelMail({
            from: process.env.MAIL_USER,
            to: mail,
            subject: "Check-out Information",
            text: `Dear ${name}, reservation ${reservation} has been confirmed. Check-in: ${checkin}, Check-out: ${checkout}, 
            Duration: ${duration}, Final Total: ${finaltotal}, Payment Method: ${payment}.`,
            html
        });

        return res.status(200).json({
            message: "check-out email accepted by SMTP server",
            delivery
        });
    } catch (error) {
        console.error(error);

        return res.status(500).json({
            message: "check-out email could not be sent"
        });
    }




    
});



router.post("/mail/cancellation", async (req, res) => {
     const {
        mail,
        name,
        reservation,
        originalcheckin,
        originalcheckout,
        rooms,
        bookingsource,
        boookingsource,
        payment
     } = req.body;

    const bookingSource = bookingsource || boookingsource || "Direct";
    const roomDetails = rooms || "Not assigned";
    const paymentDetails = payment || "Not specified";

    if (!mail || !name || !reservation || !originalcheckin || !originalcheckout) {
        return res.status(400).json({
            message: "mail, name, reservation, originalcheckin and originalcheckout are required"
        });
    }

    const html = createEmailTemplate({
        title: "BOOKING CANCELLED",
        name,
        message: `Reservation ${reservation} has been cancelled.`,
        color: "#b91c1c",
        details: [
            { label: "Reservation", value: reservation },
            { label: "Original check-in", value: originalcheckin },
            { label: "Original check-out", value: originalcheckout },
            { label: "Rooms", value: roomDetails },
            { label: "Booking source", value: bookingSource },
            { label: "Payment", value: paymentDetails }
        ],
        contactTitle: "Need help with this cancellation?",
        contactMessage: "Contact Ronaka Airport Transit Hotel at +94 70 355 1340 if you have any questions."
    });

    try {
        const delivery = await sendHotelMail({
            from: process.env.MAIL_USER,
            to: mail,
            subject: "Cancellation Information",
            text: `Dear ${name}, reservation ${reservation} has been cancelled. Check-in: ${originalcheckin}, Check-out: ${originalcheckout}, 
            Rooms: ${roomDetails}, Booking Source: ${bookingSource}, Payment Method: ${paymentDetails}.`,
            html
        });

        return res.status(200).json({
            message: "cancellation email accepted by SMTP server",
            delivery
        });
    } catch (error) {
        console.error(error);

        return res.status(500).json({
            message: "cancellation email could not be sent"
        });
    }




    
});




router.post("/mail/remind", async (req, res) => {
     const { mail, name, reservation ,checkin , checkout , nights, rooms ,balance ,
          spereq, } = req.body;

    if (!mail || !name || !reservation || !checkin || !checkout || !nights || !rooms || !balance || !spereq ) {
        return res.status(400).json({
            message: "mail, name ,reservation ,checkin ,checkout ,nights ,rooms ,balance ,special request are required"
        });
    }

    const html = createEmailTemplate({
        title: "UPCOMING STAY REMINDER",
        name,
        message: `This is a friendly reminder about reservation ${reservation}.`,
        color: "#b45309",
        details: [
            { label: "Reservation", value: reservation },
            { label: "Check-in", value: checkin },
            { label: "Check-out", value: checkout },
            { label: "Nights", value: nights },
            { label: "Rooms", value: rooms },
            { label: "Balance / payment", value: balance },
            { label: "Special requests", value: spereq }
        ],
        contactTitle: "We look forward to welcoming you",
        contactMessage: "For changes or questions, contact Ronaka Airport Transit Hotel at +94 70 355 1340."
    });

    try {
        const delivery = await sendHotelMail({
            from: process.env.MAIL_USER,
            to: mail,
            subject: "Reminder Information",
            text: `Dear ${name}, this is a reminder about your reservation ${reservation}. Check-in: ${checkin}, Check-out: ${checkout}, 
            Nights: ${nights}, Rooms: ${rooms}, Balance: ${balance}, Special Request: ${spereq}.`,
            html
        });

        return res.status(200).json({
            message: "reminder email accepted by SMTP server",
            delivery
        });
    } catch (error) {
        console.error(error);

        return res.status(500).json({
            message: "reminder email could not be sent"
        });
    }




    
});


router.post("/mail/no-show", async (req, res) => {
    const {
        mail,
        name,
        reservation,
        checkin,
        checkout,
        rooms,
        total,
        payment
    } = req.body;

    if (
        !mail ||
        !name ||
        !reservation ||
        !checkin ||
        !checkout ||
        !rooms ||
        total === undefined ||
        !payment
    ) {
        return res.status(400).json({
            message: "Required no-show details are missing"
        });
    }


    const html = createEmailTemplate({
        title: "WE MISSED YOU",
        name,
        message:
            `Our records show that you did not check in for reservation ${reservation}.`,
        color: "#475569",

        details: [
            {
                label: "Reservation",
                value: reservation
            },
            {
                label: "Scheduled check-in",
                value: checkin
            },
            {
                label: "Scheduled check-out",
                value: checkout
            },
            {
                label: "Rooms",
                value: rooms
            },
            {
                label: "Total",
                value: `LKR ${total}`
            },
            {
                label: "Payment status",
                value: payment
            }
        ],

        contactTitle: "Please contact us",
        contactMessage:
            "If this is incorrect or you need help, contact our hotel at +94 70 355 1340."
    });

    try {
        const delivery = await sendHotelMail({
            from: process.env.MAIL_USER,
            to: mail,
            subject: `No-show Notice - ${reservation}`,

            html
        });



        return res.status(200).json({
            message: "No-show email accepted by SMTP server",
            delivery
        });
    } catch (error) {
        console.error(error);

        return res.status(500).json({
            message: "No-show email could not be sent"
        });
    }
});





router.post("/mail/general", async (req, res) => {
     const { mail, name, subject = "General Information", message = "This is a general notification." } = req.body;

    if (!mail || !name || !subject || !message) {
        return res.status(400).json({
            message: "mail, name, subject and message are required"
        });
    }

    const html = createEmailTemplate({
        title: subject,
        name,
        message,
        color: "#6d28d9",
        details: [],
        contactTitle: "Kind regards",
        contactMessage: "Ronaka Airport Transit Hotel - +94 70 355 1340"
    });

    try {
        const delivery = await sendHotelMail({
            from: process.env.MAIL_USER,
            to: mail,
            subject,
            text: `Dear ${name}, ${message}`,
            html
        });

        return res.status(200).json({
            message: "general email accepted by SMTP server",
            delivery
        });
    } catch (error) {
        console.error(error);

        return res.status(500).json({
            message: "general email could not be sent"
        });
    }




    
});
module.exports = router;
